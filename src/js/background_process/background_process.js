'use strict';

console.log('background_process.js starting');

migrate_global(function() {
  account_storage_set(null, {
    version: cryptup_version_integer(),
  }, callback);
});

chrome_message_background_listen({
  migrate_account: migrate_account,
  google_auth: google_auth,
  gmail_auth_code_result: google_auth_window_result_handler,
  list_pgp_attachments: list_pgp_attachments,
  settings: open_settings_page_handler,
  attest_requested: attest_requested_handler,
  attest_packet_received: attest_packet_received_handler,
  update_uninstall_url: update_uninstall_url,
  get_active_tab_info: get_active_tab_info,
  runtime: function(message, sender, respond) {
    respond({
      environment: get_environment(),
      version: chrome.runtime.getManifest().version,
    });
  },
  ping: function(message, sender, respond) {
    respond(true);
  },
  _tab_: function(request, sender, respond) {
    respond(sender.tab.id);
  },
});

update_uninstall_url();

account_storage_get(null, 'errors', function(storage) {
  if(storage.errors && storage.errors.length && storage.errors.length > 100) {
    account_storage_remove(null, 'errors');
  }
});

if(!localStorage.settings_seen) {
  open_settings_page('initial.htm'); // called after the very first installation of the plugin
  localStorage.settings_seen = true;
  inject_cryptup_into_gmail_if_needed('notification_only');
}

Try(check_keyserver_pubkey_fingerprints)();
TrySetInterval(check_keyserver_pubkey_fingerprints, 1000 * 60 * 60 * 6);


function open_settings_page_handler(message, sender, respond) {
  open_settings_page(message.path, message.account_email, message.page);
  respond();
}

function get_active_tab_info(request, sender, respond) {
  chrome.tabs.query({
    active: true,
    url: "*://mail.google.com/*",
  }, function(tabs) {
    if(tabs.length) {
      chrome.tabs.executeScript(tabs[0].id, {
        code: 'var r = {account_email: window.account_email_global, same_world: window.same_world_global}; r'
      }, function(result) {
        respond({
          provider: 'gmail',
          account_email: result[0].account_email || null,
          same_world: result[0].same_world === true,
        });
      });
    } else {
      respond({
        provider: null,
        account_email: null,
        same_world: null,
      });
    }
  });
}

function list_pgp_attachments(request, sender, respond) {
  gmail_api_message_get(request.account_email, request.message_id, 'full', function(success, message) {
    if(success) {
      var attachments = gmail_api_find_attachments(message);
      var pgp_attachments = [];
      var pgp_messages = [];
      var pgp_signatures = [];
      var pgp_hide = [];
      $.each(attachments, function(i, attachment) {
        if(attachment.name.match('(\.pgp)|(\.gpg)$')) {
          pgp_attachments.push(attachment);
        } else if(attachment.name === 'signature.asc') {
          pgp_signatures.push(attachment);
        } else if(attachment.name.match('(\.asc)$')) {
          pgp_messages.push(attachment);
        } else if(attachment.name === '') {
          pgp_hide.push(attachment);
        }
      });
      respond({
        success: true,
        attachments: pgp_attachments,
        signatures: pgp_signatures,
        messages: pgp_messages,
        hide: pgp_hide,
        message_id: request.message_id,
      });
    } else {
      respond({
        success: false,
        message_id: request.message_id,
      });
    }
  });
}

function update_uninstall_url(request, sender, respond) {
  get_account_emails(function(account_emails) {
    account_storage_get(null, ['metrics'], function(storage) {
      if(typeof chrome.runtime.setUninstallURL !== 'undefined') {
        chrome.runtime.setUninstallURL('https://cryptup.org/leaving.htm#' + encodeURIComponent(JSON.stringify({
          email: (account_emails && account_emails.length) ? account_emails[0] : null,
          metrics: storage.metrics || null,
        })));
      }
      if(respond) {
        respond();
      }
    });
  });
}
