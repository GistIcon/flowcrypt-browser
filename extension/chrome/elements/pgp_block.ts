/* © 2016-2018 FlowCrypt Limited. Limitations apply. Contact human@flowcrypt.com */

'use strict';

import { Store } from '../../js/common/store.js';
import { Catch, Env, Value, Str, Dict } from './../../js/common/common.js';
import { Att } from '../../js/common/att.js';
import { Xss, Ui } from '../../js/common/browser.js';
import { BgExec, BrowserMsg } from '../../js/common/extension.js';
import { Lang } from './../../js/common/lang.js';

import { Api, GmailResponseFormat, R } from '../../js/common/api.js';
import { MsgVerifyResult, DecryptErrTypes, Pgp } from '../../js/common/pgp.js';
import { Mime } from '../../js/common/mime.js';

declare const anchorme: (input: string, opts: {emails?: boolean, attributes?: {name: string, value: string}[]}) => string;

Catch.try(async () => {

  Ui.event.protect();

  let urlParams = Env.urlParams(['account_email', 'frame_id', 'message', 'parent_tab_id', 'message_id', 'is_outgoing', 'sender_email', 'has_password', 'signature', 'short']);
  let account_email = Env.urlParamRequire.string(urlParams, 'account_email');
  let parent_tab_id = Env.urlParamRequire.string(urlParams, 'parent_tab_id');
  let has_challenge_password = urlParams.has_password === true;
  let frame_id = urlParams.frame_id;
  let is_outgoing = urlParams.is_outgoing === true;
  let signature = urlParams.signature || null;
  let short = urlParams.short;
  let sender_email = urlParams.sender_email;
  let message_id = urlParams.message_id;
  let message = urlParams.message;

  let included_atts: Att[] = [];
  let height_history: number[] = [];
  let msg_fetched_from_api: false|GmailResponseFormat = false;
  let passphrase_interval: number|undefined;
  let missing_or_wrong_passprases: Dict<string|null> = {};
  let can_read_emails: undefined|boolean;
  let password_message_link_result: R.FcLinkMsg;
  let admin_codes: string[];
  let user_entered_message_password: string|undefined;

  let do_anchor = (text: string) => {
    return anchorme(text.replace(/\n/g, '<br>'), { emails: false, attributes: [{ name: 'target', value: '_blank' }] });
  };

  let render_text = (text: string) => {
    document.getElementById('pgp_block')!.innerText = text; // pgp_block.htm
  };

  let send_resize_message = () => {
    let height = $('#pgp_block').height()! + 40; // pgp_block.htm

    let is_infinite_resize_loop = () => {
      height_history.push(height);
      let len = height_history.length;
      if (len < 4) {
        return false;
      }
      if (height_history[len - 1] === height_history[len - 3] && height_history[len - 2] === height_history[len - 4] && height_history[len - 1] !== height_history[len - 2]) {
        console.info('pgp_block.js: repetitive resize loop prevented'); // got repetitive, eg [70, 80, 200, 250, 200, 250]
        height = Math.max(height_history[len - 1], height_history[len - 2]);
      }
    };

    if (!is_infinite_resize_loop()) {
      BrowserMsg.send(parent_tab_id, 'set_css', {selector: `iframe#${frame_id}`, css: {height}});
    }
  };

  let set_test_state = (state: 'ready' | 'working') => {
    $('body').attr('data-test-state', state); // for automated tests
  };

  let display_image_src_link_as_image = (a: HTMLAnchorElement, event: JQuery.Event<HTMLAnchorElement, null>) => {
    let img = document.createElement('img');
    img.setAttribute('style', a.getAttribute('style') || '');
    img.style.background = 'none';
    img.style.border = 'none';
    img.addEventListener('load', () => send_resize_message());
    if(a.href.indexOf('cid:') === 0) { // image included in the email
      let content_id = a.href.replace(/^cid:/g, '');
      let content = included_atts.filter(a => a.type.indexOf('image/') === 0 && a.cid === `<${content_id}>`)[0];
      if(content) {
        img.src = `data:${a.type};base64,${btoa(content.asText())}`;
        a.outerHTML = img.outerHTML; // xss-safe-value - img.outerHTML was built using dom node api
      } else {
        a.outerHTML = Xss.htmlEscape(`[broken link: ${a.href}]`); // xss-escaped
      }
    } else if(a.href.indexOf('https://') === 0 || a.href.indexOf('http://') === 0) {
      img.src = a.href;
      a.outerHTML = img.outerHTML; // xss-safe-value - img.outerHTML was built using dom node api
    } else {
      a.outerHTML = Xss.htmlEscape(`[broken link: ${a.href}]`); // xss-escaped
    }
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  let render_content = async (html_content: string, is_error: boolean) => {
    if (!is_error && !is_outgoing) { // successfully opened incoming message
      await Store.set(account_email, { successfully_received_at_leat_one_message: true });
    }
    if(!is_error) { // rendering message content
      let pgp_block = $('#pgp_block').html(Xss.htmlSanitizeKeepBasicTags(html_content)); // xss-sanitized
      pgp_block.find('a.image_src_link').one('click', Ui.event.handle(display_image_src_link_as_image));
    } else { // rendering our own ui
      Xss.sanitizeRender('#pgp_block', html_content);
    }
    // if (unsecure_mdc_ignored && !is_error) {
    //   set_frame_color('red');
    //   Xss.sanitize_prepend('#pgp_block', '<div style="border: 4px solid #d14836;color:#d14836;padding: 5px;">' + Lang.pgp_block.mdc_warning.replace(/\n/g, '<br>') + '</div><br>');
    // }
    if (is_error) {
      $('.action_show_raw_pgp_block').click(Ui.event.handle(target => {
        $('.raw_pgp_block').css('display', 'block');
        $(target).css('display', 'none');
        send_resize_message();
      }));
    }
    // resize window now
    send_resize_message();
    // start auto-resizing the window after 1s
    Catch.setHandledTimeout(() => $(window).resize(Ui.event.prevent('spree', send_resize_message)), 1000);
  };

  let button_html = (text: string, add_classes: string) => {
    return `<div class="button long ${add_classes}" style="margin:30px 0;" target="cryptup">${text}</div>`;
  };

  let armored_message_as_html = (raw_message_substitute:string|null=null) => {
    let m = raw_message_substitute || message;
    if (m && typeof m === 'string') {
      return `<div class="raw_pgp_block" style="display: none;">${Xss.htmlEscape(m).replace(/\n/g, '<br>')}</div><a href="#" class="action_show_raw_pgp_block">show original message</a>`;
    }
    return '';
  };

  let set_frame_color = (color: 'red'|'green'|'gray') => {
    if (color === 'red') {
      $('#pgp_background').removeClass('pgp_secure').removeClass('pgp_neutral').addClass('pgp_insecure');
    } else if (color === 'green') {
      $('#pgp_background').removeClass('pgp_neutral').removeClass('pgp_insecure').addClass('pgp_secure');
    } else {
      $('#pgp_background').removeClass('pgp_secure').removeClass('pgp_insecure').addClass('pgp_neutral');
    }
  };

  let render_error = async (error_box_content: string, raw_message_substitute:string|null=null) => {
    set_frame_color('red');
    await render_content('<div class="error">' + error_box_content.replace(/\n/g, '<br>') + '</div>' + armored_message_as_html(raw_message_substitute), true);
    $('.button.settings_keyserver').click(Ui.event.handle(() => BrowserMsg.send(null, 'settings', {account_email, page: '/chrome/settings/modules/keyserver.htm'})));
    $('.button.settings').click(Ui.event.handle(() => BrowserMsg.send(null, 'settings', {account_email})));
    $('.button.settings_add_key').click(Ui.event.handle(() => BrowserMsg.send(null, 'settings', {account_email, page: '/chrome/settings/modules/add_key.htm'})));
    $('.button.reply_pubkey_mismatch').click(Ui.event.handle(() => {
      BrowserMsg.send(parent_tab_id, 'reply_pubkey_mismatch');
    }));
    set_test_state('ready');
  };

  let handle_private_key_mismatch = async (account_email: string, message: string) => { // todo - make it work for multiple stored keys
    let msg_diagnosis = await BgExec.diagnose_msg_pubkeys(account_email, message);
    if (msg_diagnosis.found_match) {
      await render_error(Lang.pgpBlock.cantOpen + Lang.pgpBlock.encryptedCorrectlyFileBug);
    } else if (msg_diagnosis.receivers === 1) {
      await render_error(Lang.pgpBlock.cantOpen + Lang.pgpBlock.singleSender + Lang.pgpBlock.askResend + button_html('account settings', 'gray2 settings_keyserver'));
    } else {
      await render_error(Lang.pgpBlock.yourKeyCantOpenImportIfHave + button_html('import missing key', 'gray2 settings_add_key') + '&nbsp; &nbsp;' + button_html('ask sender to update', 'gray2 short reply_pubkey_mismatch') + '&nbsp; &nbsp;' + button_html('settings', 'gray2 settings_keyserver'));
    }
  };

  let decrypt_pwd = async (supplied_password?: string|null): Promise<string|null> => {
    let pwd = supplied_password || user_entered_message_password || null;
    if(pwd && has_challenge_password) {
      return await BgExec.crypto_hash_challenge_answer(pwd);
    }
    return pwd;
  };

  let decrypt_and_save_att_to_downloads = async (encrypted: Att, render_in: JQuery<HTMLElement>) => {
    let decrypted = await BgExec.crypto_msg_decrypt(account_email, encrypted.data(), await decrypt_pwd(), true);
    if (decrypted.success) {
      let att = new Att({name: encrypted.name.replace(/(\.pgp)|(\.gpg)$/, ''), type: encrypted.type, data: decrypted.content.uint8!});
      Att.methods.saveToDownloads(att, render_in);
      send_resize_message();
    } else {
      delete decrypted.message;
      console.info(decrypted);
      alert('There was a problem decrypting this file. Downloading encrypted original. Email human@flowcrypt.com if this happens repeatedly.');
      Att.methods.saveToDownloads(encrypted, render_in);
      send_resize_message();
    }
  };

  let render_progress = (element: JQuery<HTMLElement>, percent: number|null, received: number|null, size: number) => {
    if (percent) {
      element.text(percent + '%');
    } else if (size && received) {
      element.text(Math.floor(((received * 0.75) / size) * 100) + '%');
    }
  };

  let render_inner_atts = (atts: Att[]) => {
    Xss.sanitizeAppend('#pgp_block', '<div id="attachments"></div>');
    included_atts = atts;
    for (let i of atts.keys()) {
      let name = (atts[i].name ? Xss.htmlEscape(atts[i].name) : 'noname').replace(/(\.pgp)|(\.gpg)$/, '');
      let size = Str.number_format(Math.ceil(atts[i].length / 1024)) + 'KB';
      Xss.sanitizeAppend('#attachments', `<div class="attachment" index="${Number(i)}"><b>${Xss.htmlEscape(name)}</b>&nbsp;&nbsp;&nbsp;${size}<span class="progress"><span class="percent"></span></span></div>`);
    }
    send_resize_message();
    $('div.attachment').click(Ui.event.prevent('double', async target => {
      let att = included_atts[Number($(target).attr('index') as string)];
      if (att.hasData()) {
        Att.methods.saveToDownloads(att, $(target));
        send_resize_message();
      } else {
        Xss.sanitizePrepend($(target).find('.progress'), Ui.spinner('green'));
        att.setData(await Att.methods.downloadAsUint8(att.url!, (perc, load, total) => render_progress($(target).find('.progress .percent'), perc, load, total || att.length)));
        await Ui.delay(100); // give browser time to render
        $(target).find('.progress').text('');
        await decrypt_and_save_att_to_downloads(att, $(target));
      }
    }));
  };

  let render_pgp_signature_check_result = (signature: MsgVerifyResult|null) => {
    if (signature) {
      let signer_email = signature.contact ? signature.contact.name || sender_email : sender_email;
      $('#pgp_signature > .cursive > span').text(String(signer_email) || 'Unknown Signer');
      if (signature.signer && !signature.contact) {
        $('#pgp_signature').addClass('neutral');
        $('#pgp_signature > .result').text('cannot verify signature');
      } else if (signature.match && signature.signer && signature.contact) {
        $('#pgp_signature').addClass('good');
        $('#pgp_signature > .result').text('matching signature');
      } else {
        $('#pgp_signature').addClass('bad');
        $('#pgp_signature > .result').text('signature does not match');
        set_frame_color('red');
      }
      $('#pgp_signature').css('block');
    }
  };

  let render_future_expiration = (date: string) => {
    let btns = '';
    if (admin_codes && admin_codes.length) {
      btns += ' <a href="#" class="extend_expiration">extend</a>';
    }
    if (is_outgoing) {
      btns += ' <a href="#" class="expire_settings">settings</a>';
    }
    Xss.sanitizeAppend('#pgp_block', Ui.e('div', {class: 'future_expiration', html: `This message will expire on ${Str.datetime_to_date(date)}. ${btns}`}));
    $('.expire_settings').click(Ui.event.handle(() => BrowserMsg.send(null, 'settings', {account_email, page: '/chrome/settings/modules/security.htm'})));
    $('.extend_expiration').click(Ui.event.handle(target => render_message_expiration_renew_options(target)));
  };

  let recover_stored_admin_codes = async () => {
    let storage = await Store.get_global(['admin_codes']);
    if (short && storage.admin_codes && storage.admin_codes[short as string] && storage.admin_codes[short as string].codes) {
      admin_codes = storage.admin_codes[short as string].codes;
    }
  };

  let render_message_expiration_renew_options = async (target: HTMLElement) => {
    let parent = $(target).parent();
    let subscription = await Store.subscription();
    if (subscription.level && subscription.active) {
      Xss.sanitizeRender(parent, '<div style="font-family: monospace;">Extend message expiration: <a href="#7" class="do_extend">+7 days</a> <a href="#30" class="do_extend">+1 month</a> <a href="#365" class="do_extend">+1 year</a></div>');
      let element = await Ui.event.clicked('.do_extend');
      await handle_extend_message_expiration_clicked(element);
    } else {
      if (subscription.level && !subscription.active && subscription.method === 'trial') {
        alert('Your trial has ended. Please renew your subscription to proceed.');
      } else {
        alert('FlowCrypt Advanced users can choose expiration of password encrypted messages. Try it free.');
      }
      BrowserMsg.send(parent_tab_id, 'subscribe_dialog');
    }
  };

  let handle_extend_message_expiration_clicked = async (self: HTMLElement) => {
    let n_days = Number($(self).attr('href')!.replace('#', ''));
    Xss.sanitizeRender($(self).parent(), 'Updating..' + Ui.spinner('green'));
    try {
      let r = await Api.fc.messageExpiration(admin_codes, n_days);
      if (r.updated) {
        window.location.reload();
      } else {
        throw r;
      }
    } catch (e) {
      if (Api.err.isAuthErr(e)) {
        alert('Your FlowCrypt account information is outdated, please review your account settings.');
        BrowserMsg.send(parent_tab_id, 'subscribe_dialog', { source: 'auth_error' });
      } else {
        Catch.report('error when extending message expiration', e);
      }
      Xss.sanitizeRender($(self).parent(), 'Error updating expiration. <a href="#" class="retry_expiration_change">Click here to try again</a>').addClass('bad');
      let el = await Ui.event.clicked('.retry_expiration_change');
      await handle_extend_message_expiration_clicked(el);
    }
  };

  let decide_decrypted_content_formatting_and_render = async (decrypted_content: Uint8Array|string, is_encrypted: boolean, signature_result: MsgVerifyResult|null) => {
    set_frame_color(is_encrypted ? 'green' : 'gray');
    render_pgp_signature_check_result(signature_result);
    let public_keys: string[] = [];
    if (decrypted_content instanceof Uint8Array) {
      decrypted_content = Str.fromUint8(decrypted_content); // functions below rely on this: resembles_message, extract_cryptup_attachments, strip_cryptup_reply_token, strip_public_keys
    }
    if (!Mime.resembles_msg(decrypted_content)) {
      let fc_atts: Att[] = [];
      decrypted_content = Str.extract_fc_atts(decrypted_content, fc_atts);
      decrypted_content = Str.strip_fc_reply_token(decrypted_content);
      decrypted_content = Str.strip_public_keys(decrypted_content, public_keys);
      if (public_keys.length) {
        BrowserMsg.send(parent_tab_id, 'render_public_keys', {after_frame_id: frame_id, public_keys});
      }
      decrypted_content = Xss.htmlEscape(decrypted_content);
      await render_content(do_anchor(decrypted_content.replace(/\n/g, '<br>')), false);
      if (fc_atts.length) {
        render_inner_atts(fc_atts);
      }
      if (password_message_link_result && password_message_link_result.expire) {
        render_future_expiration(password_message_link_result.expire);
      }
    } else {
      render_text('Formatting...');
      let decoded = await Mime.decode(decrypted_content);
      if (typeof decoded.html !== 'undefined') {
        await render_content(decoded.html, false);
      } else if(typeof decoded.text !== 'undefined') {
        await render_content(do_anchor(decoded.text.replace(/\n/g, '<br>')), false);
      } else {
        await render_content((decrypted_content || '').replace(/\n/g, '<br>'), false); // not sure about the replace, time will tell
      }
      let renderable_atts: Att[] = [];
      for (let att of decoded.atts) {
        if (att.treatAs() !== 'public_key') {
          renderable_atts.push(att);
        } else {
          public_keys.push(att.asText());
        }
      }
      if (renderable_atts.length) {
        render_inner_atts(decoded.atts);
      }
      if (public_keys.length) {
        BrowserMsg.send(parent_tab_id, 'render_public_keys', {after_frame_id: frame_id, public_keys});
      }
    }
    set_test_state('ready');
  };

  let decrypt_and_render = async (optional_password:string|null=null) => {
    if (typeof signature !== 'string') {
      let result = await BgExec.crypto_msg_decrypt(account_email, message as string|Uint8Array, await decrypt_pwd(optional_password));
      if (typeof result === 'undefined') {
        await render_error(Lang.general.restartBrowserAndTryAgain);
      } else if (result.success) {
        if (has_challenge_password && optional_password) {
          user_entered_message_password = optional_password;
        }
        if (result.success && result.signature && result.signature.contact && !result.signature.match && can_read_emails && msg_fetched_from_api !== 'raw') {
          console.info(`re-fetching message ${message_id} from api because failed signature check: ${!msg_fetched_from_api ? 'full' : 'raw'}`);
          await initialize(true);
        } else {
          await decide_decrypted_content_formatting_and_render(result.content.text!, Boolean(result.is_encrypted), result.signature); // text!: did not request uint8
        }
      } else if (result.error.type === DecryptErrTypes.format) {
        if (can_read_emails && msg_fetched_from_api !== 'raw') {
          console.info(`re-fetching message ${message_id} from api because looks like bad formatting: ${!msg_fetched_from_api ? 'full' : 'raw'}`);
          await initialize(true);
        } else {
          await render_error(Lang.pgpBlock.badFormat + '\n\n' + result.error.error);
        }
      } else if (result.longids.need_passphrase.length) {
        await render_passphrase_prompt(result.longids.need_passphrase);
      } else {
        let [primary_k] = await Store.keysGet(account_email, ['primary']);
        if (!result.longids.chosen && !primary_k) {
          await render_error(Lang.pgpBlock.notProperlySetUp + button_html('FlowCrypt settings', 'green settings'));
        } else if (result.error.type === DecryptErrTypes.key_mismatch) {
          if (has_challenge_password && !optional_password) {
            await render_password_prompt('first');
          } else {
            await handle_private_key_mismatch(account_email, message as string);
          }
        } else if (result.error.type === DecryptErrTypes.wrong_password) {
          await render_password_prompt('retry');
        } else if (result.error.type === DecryptErrTypes.use_password) {
          await render_password_prompt('first');
        } else if (result.error.type === DecryptErrTypes.no_mdc) {
          await render_error('This message may not be safe to open: missing MDC. To open this message, please go to FlowCrypt Settings -> Additional Settings -> Exprimental -> Decrypt message without MDC');
        } else if (result.error) {
          await render_error(`${Lang.pgpBlock.cantOpen}\n\n<em>${result.error.type}: ${result.error.error}</em>`);
        } else { // should generally not happen
          delete result.message;
          await render_error(Lang.pgpBlock.cantOpen + Lang.pgpBlock.writeMe + '\n\nDiagnostic info: "' + JSON.stringify(result) + '"');
        }
      }
    } else {
      let signature_result = await BgExec.crypto_msg_verify_detached(account_email, message as string|Uint8Array, signature);
      await decide_decrypted_content_formatting_and_render(message as string, false, signature_result);
    }
  };

  let render_passphrase_prompt = async (missing_or_wrong_pp_k_longids: string[]) => {
    missing_or_wrong_passprases = {};
    let passphrases = await Promise.all(missing_or_wrong_pp_k_longids.map(longid => Store.passphrase_get(account_email, longid)));
    for (let i of missing_or_wrong_pp_k_longids.keys()) {
      missing_or_wrong_passprases[missing_or_wrong_pp_k_longids[i]] = passphrases[i];
      await render_error('<a href="#" class="enter_passphrase">' + Lang.pgpBlock.enterPassphrase + '</a> ' + Lang.pgpBlock.toOpenMsg, undefined);
      clearInterval(passphrase_interval);
      passphrase_interval = Catch.setHandledInterval(check_passphrase_changed, 1000);
      $('.enter_passphrase').click(Ui.event.handle(() => {
        BrowserMsg.send(parent_tab_id, 'passphrase_dialog', { type: 'message', longids: missing_or_wrong_pp_k_longids });
        clearInterval(passphrase_interval);
        passphrase_interval = Catch.setHandledInterval(check_passphrase_changed, 250);
      }));
    }
  };

  let render_password_prompt = async (attempt: 'first' | 'retry') => {
    let prompt = `<p>${attempt === 'first' ? '' : Lang.pgpBlock.wrongPassword}${Lang.pgpBlock.decryptPasswordPrompt}</p>`;
    prompt += '<p><input id="answer" placeholder="Password" data-test="input-message-password"></p><p><div class="button green long decrypt" data-test="action-decrypt-with-password">decrypt message</div></p>';
    prompt += armored_message_as_html();
    await render_content(prompt, true);
    set_test_state('ready');
    await Ui.event.clicked('.button.decrypt');
    set_test_state('working'); // so that test suite can wait until ready again
    $(self).text('Opening');
    await Ui.delay(50); // give browser time to render
    await decrypt_and_render($('#answer').val() as string); // text input
  };

  let check_passphrase_changed = async () => {
    let longids = Object.keys(missing_or_wrong_passprases);
    let updated_passphrases = await Promise.all(longids.map(longid => Store.passphrase_get(account_email, longid)));
    for (let longid of longids) {
      if ((missing_or_wrong_passprases[longid] || null) !== updated_passphrases[longids.indexOf(longid)]) {
        missing_or_wrong_passprases = {};
        clearInterval(passphrase_interval);
        await decrypt_and_render();
        return;
      }
    }
  };

  let render_password_encrypted_message_load_fail = async (link_result: R.FcLinkMsg) => {
    if (link_result.expired) {
      let expiration_m = Lang.pgpBlock.msgExpiredOn + Str.datetime_to_date(link_result.expire) + '. ' + Lang.pgpBlock.msgsDontExpire + '\n\n';
      if (link_result.deleted) {
        expiration_m += Lang.pgpBlock.msgDestroyed;
      } else if (is_outgoing && admin_codes) {
        expiration_m += '<div class="button gray2 extend_expiration">renew message</div>';
      } else if (!is_outgoing) {
        expiration_m += Lang.pgpBlock.askSenderRenew;
      }
      expiration_m += '\n\n<div class="button gray2 action_security">security settings</div>';
      await render_error(expiration_m, null);
      set_frame_color('gray');
      $('.action_security').click(Ui.event.handle(() => BrowserMsg.send(null, 'settings', {page: '/chrome/settings/modules/security.htm'})));
      $('.extend_expiration').click(Ui.event.handle(render_message_expiration_renew_options));
    } else if (!link_result.url) {
      await render_error(Lang.pgpBlock.cannotLocate + Lang.pgpBlock.brokenLink);
    } else {
      await render_error(Lang.pgpBlock.cannotLocate + Lang.general.writeMeToFixIt + ' Details:\n\n' + Xss.htmlEscape(JSON.stringify(link_result)));
    }
  };

  let initialize = async (force_pull_message_from_api=false) => {
    try {
      if (can_read_emails && message && signature === true) {
        render_text('Loading signature...');
        let result = await Api.gmail.msgGet(account_email, message_id as string, 'raw');
        if (!result.raw) {
          await decrypt_and_render();
        } else {
          msg_fetched_from_api = 'raw';
          let mime_message = Str.base64urlDecode(result.raw);
          let parsed = Mime.signed(mime_message);
          if (parsed) {
            signature = parsed.signature;
            message = parsed.signed;
            await decrypt_and_render();
          } else {
            let decoded = await Mime.decode(mime_message);
            signature = decoded.signature || null;
            console.info('%c[___START___ PROBLEM PARSING THIS MESSSAGE WITH DETACHED SIGNATURE]', 'color: red; font-weight: bold;');
            console.info(mime_message);
            console.info('%c[___END___ PROBLEM PARSING THIS MESSSAGE WITH DETACHED SIGNATURE]', 'color: red; font-weight: bold;');
            await decrypt_and_render();
          }
        }
      } else if (message && !force_pull_message_from_api) { // ascii armored message supplied
        render_text(signature ? 'Verifying..' : 'Decrypting...');
        await decrypt_and_render();
      } else if (!message && has_challenge_password && short) { // need to fetch the message from FlowCrypt API
        render_text('Loading message...');
        await recover_stored_admin_codes();
        let m_link_result = await Api.fc.linkMessage(short as string);
        password_message_link_result = m_link_result;
        if (m_link_result.url) {
          let download_uint_result = await Att.methods.downloadAsUint8(m_link_result.url, null);
          message = Str.fromUint8(download_uint_result);
          await decrypt_and_render();
        } else {
          await render_password_encrypted_message_load_fail(password_message_link_result);
        }
      } else {  // need to fetch the inline signed + armored or encrypted +armored message block from gmail api
        if (can_read_emails) {
          render_text('Retrieving message...');
          let format: GmailResponseFormat = (!msg_fetched_from_api) ? 'full' : 'raw';
          message = await Api.gmail.extractArmoredBlock(account_email, message_id as string, format);
          render_text('Decrypting...');
          msg_fetched_from_api = format;
          await decrypt_and_render();
        } else { // gmail message read auth not allowed
          Xss.sanitizeRender('#pgp_block', 'This encrypted message is very large (possibly containing an attachment). Your browser needs to access gmail it in order to decrypt and display the message.<br/><br/><br/><div class="button green auth_settings">Add missing permission</div>');
          send_resize_message();
          $('.auth_settings').click(Ui.event.handle(() => BrowserMsg.send(null, 'settings', { account_email, page: '/chrome/settings/modules/auth_denied.htm' })));
        }
      }
    } catch (e) {
      if (Api.err.isNetErr(e)) {
        await render_error(`Could not load message due to network error. ${Ui.retryLink()}`);
      } else if(Api.err.isAuthPopupNeeded(e)) {
        BrowserMsg.send(parent_tab_id, 'notification_show_auth_popup_needed', {account_email});
        await render_error(`Could not load message due to missing auth. ${Ui.retryLink()}`);
      } else if (Value.is(Pgp.armor.headers('public_key').end as string).in(e.data)) { // public key .end is always string
        window.location.href = Env.urlCreate('pgp_pubkey.htm', { armored_pubkey: e.data, minimized: Boolean(is_outgoing), account_email, parent_tab_id, frame_id });
      } else if (Api.err.isStandardErr(e, 'format')) {
        console.log(e.data);
        await render_error(Lang.pgpBlock.cantOpen + Lang.pgpBlock.badFormat + Lang.pgpBlock.dontKnowHowOpen, e.data);
      } else {
        Catch.handle_exception(e);
        await render_error(String(e));
      }
    }
  };

  let storage = await Store.getAccount(account_email, ['setup_done', 'google_token_scopes']);
  can_read_emails = Api.gmail.hasScope(storage.google_token_scopes || [], 'read');
  if (storage.setup_done) {
    await initialize();
  } else {
    await render_error(Lang.pgpBlock.refreshWindow, message as string || '');
  }

})();