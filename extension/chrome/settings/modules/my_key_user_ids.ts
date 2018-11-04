/* © 2016-2018 FlowCrypt Limited. Limitations apply. Contact human@flowcrypt.com */

'use strict';

import { Store } from '../../../js/common/store.js';
import { Catch, Env, Dict } from '../../../js/common/common.js';
import { Xss } from '../../../js/common/browser.js';
import { Settings } from '../../../js/common/settings.js';

declare const openpgp: typeof OpenPGP;

Catch.try(async () => {

  let urlParams = Env.urlParams(['account_email', 'longid', 'parent_tab_id']);
  let account_email = Env.urlParamRequire.string(urlParams, 'account_email');
  let parent_tab_id = Env.urlParamRequire.string(urlParams, 'parent_tab_id');

  $('.action_show_public_key').attr('href', Env.urlCreate('my_key.htm', urlParams));

  let [primary_ki] = await Store.keysGet(account_email, [urlParams.longid as string || 'primary']);
  Settings.abort_and_render_error_if_keyinfo_empty(primary_ki);

  let key = openpgp.key.readArmored(primary_ki.private).keys[0];

  let user_ids = key.users.map((u: any) => u.userId.userid); // todo - create a common function in settings.js for here and setup.js user_ids
  Xss.sanitizeRender('.user_ids', user_ids.map((uid: string) => `<div>${Xss.htmlEscape(uid)}</div>`).join(''));

  $('.email').text(account_email);
  $('.key_words').text(primary_ki.keywords);

})();