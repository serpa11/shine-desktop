/* ==========================================================================
   Shine Desktop - injected into the page's main world.

   Deliberately small:
     * a window bar: title, Control PC switch, activity log, minimise,
       maximise, close
     * an approval dialog shown before Shine touches the PC
     * transparent routing of the site's own AI requests through the PC
       Control agent, and of the site's own microphone button through the
       dictation engines

   No logos, no settings panel, no setup wizard, no colour.
   ========================================================================== */

(function () {
  'use strict';

  // The preload sets window.__shineDesktopInjected *before* evaluating this
  // file (that is its own de-dupe flag), so the guard here uses another one.
  if (window.__shineDesktopUi) return;

  var D = window.shineDesktop;
  if (!D) {
    console.warn('[shine-desktop] window.shineDesktop is missing; preload did not run.');
    return;
  }

  /* ======================================================================
     Helpers
     ====================================================================== */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function svg(paths) {
    var ns = 'http://www.w3.org/2000/svg';
    var node = document.createElementNS(ns, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      node.appendChild(p);
    });
    return node;
  }

  var GLYPH = {
    minimize: ['M5 12h14'],
    maximize: ['M5 5h14v14H5z'],
    restore: ['M8 8h11v11H8z', 'M5 16V5h11'],
    close: ['M6 6l12 12', 'M18 6L6 18'],
    user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20a7.5 7.5 0 0 1 15 0'],
  };

  /* ======================================================================
     Toasts
     ====================================================================== */

  var ToastHost = (function () {
    var host = null;
    function ensure() {
      if (host && document.body.contains(host)) return host;
      host = el('div', { class: 'shine-toasts' });
      document.body.appendChild(host);
      return host;
    }
    return {
      show: function (title, text, ttl) {
        var node = el('div', { class: 'shine-toast' }, [
          el('div', { class: 'shine-toast-title', text: title }),
          text ? el('div', { class: 'shine-toast-text', text: String(text) }) : null,
        ]);
        ensure().appendChild(node);
        setTimeout(function () {
          node.classList.add('leaving');
          setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
          }, 220);
        }, ttl || 4200);
        return node;
      },
    };
  })();

  /* ======================================================================
     Modal shell
     ====================================================================== */

  var Modal = (function () {
    var root = null;

    function ensureRoot() {
      if (root && document.body.contains(root)) return root;
      root = el('div', { class: 'shine-modal-root' });
      document.body.appendChild(root);
      return root;
    }

    function open(opts) {
      var host = ensureRoot();
      host.innerHTML = '';

      var body = el('div', { class: 'shine-modal-body' });
      if (typeof opts.render === 'function') opts.render(body);

      var foot = el('div', { class: 'shine-modal-foot' });
      var modal = el('div', { class: 'shine-modal' }, [
        el('div', { class: 'shine-modal-head' }, [
          el('div', { class: 'shine-modal-title', text: opts.title || '' }),
          opts.sub ? el('div', { class: 'shine-modal-sub', text: opts.sub }) : null,
        ]),
        body,
        foot,
      ]);

      host.appendChild(modal);
      host.classList.add('open');

      var api = {
        close: function () {
          host.classList.remove('open');
          setTimeout(function () {
            if (!host.classList.contains('open')) host.innerHTML = '';
          }, 180);
          if (opts.onClose) opts.onClose();
        },
        body: body,
        foot: foot,
      };

      if (typeof opts.footer === 'function') opts.footer(foot, api);
      return api;
    }

    return { open: open };
  })();

  /* ======================================================================
     Reading the site's own settings from localStorage
     ====================================================================== */

  var ShineStore = {
    read: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (e) {
        return fallback;
      }
    },
    ai: function () {
      var settings = ShineStore.read('shineAISettings', null);
      if (!settings || typeof settings !== 'object') {
        settings = {
          activeProvider: '',
          openai: { key: '', model: '' },
          claude: { key: '', model: '' },
          gemini: { key: '', model: '' },
          grok: { key: '', model: '' },
          custom: { key: '', model: '', baseUrl: '', authStyle: 'bearer' },
        };
      }
      settings.custom = settings.custom || { key: '', model: '', baseUrl: '', authStyle: 'bearer' };
      return settings;
    },
    /** Credentials for Whisper-compatible dictation, reusing the saved keys. */
    sttCredentials: function () {
      var ai = ShineStore.ai();
      var intel = ShineStore.read('shineIntelligenceSettings', null);
      var connections = (intel && intel.connections) || {};
      var custom = ai.custom || {};

      if (custom.baseUrl && custom.key) {
        return { sttProvider: 'custom', sttBaseUrl: String(custom.baseUrl).replace(/\/+$/, ''), sttApiKey: custom.key };
      }
      if (connections.groq && connections.groq.key) return { sttProvider: 'groq', sttApiKey: connections.groq.key };
      if (ai.openai && ai.openai.key) return { sttProvider: 'openai', sttApiKey: ai.openai.key };
      return { sttProvider: '', sttApiKey: '', sttBaseUrl: '' };
    },
  };

  /* ======================================================================
     Conversation helpers
     ====================================================================== */

  /** Prior turns from the visible transcript, so the agent has context. */
  function readHistory(limit) {
    var convo = document.querySelector('.conversation');
    if (!convo) return [];
    var out = [];
    var messages = convo.querySelectorAll('.message');
    for (var i = 0; i < messages.length; i += 1) {
      var node = messages[i];
      if (node.classList.contains('shine-desktop-note')) continue;
      var text = (node.innerText || '').trim();
      if (!text || text === 'Thinking') continue;
      out.push({ role: node.classList.contains('user') ? 'user' : 'assistant', text: text.slice(0, 6000) });
    }
    return out.slice(-(limit || 10));
  }

  function insertAfter(afterNode, node) {
    var convo = document.querySelector('.conversation');
    if (!convo) return;
    if (afterNode && afterNode.parentNode) afterNode.parentNode.insertBefore(node, afterNode.nextSibling);
    else convo.appendChild(node);
  }

  /** Wait until Shine has rendered the assistant reply, then hand back its node. */
  function afterAssistantReply(answerText, callback) {
    var convo = document.querySelector('.conversation');
    if (!convo) return;
    var needle = String(answerText || '').slice(0, 40);
    var deadline = Date.now() + 8000;
    (function poll() {
      var nodes = Array.prototype.slice.call(convo.querySelectorAll('.message.assistant'));
      var match = null;
      for (var i = nodes.length - 1; i >= 0; i -= 1) {
        if (nodes[i].classList.contains('shine-desktop-note')) continue;
        if ((nodes[i].innerText || '').indexOf(needle) === 0) { match = nodes[i]; break; }
      }
      if (match) { callback(match); return; }
      if (Date.now() > deadline) { if (nodes.length) callback(nodes[nodes.length - 1]); return; }
      setTimeout(poll, 120);
    })();
  }

  function appendScreenshots(shots, afterNode) {
    shots.forEach(function (shot) {
      var card = el('div', { class: 'shine-message-image-card' }, [
        el('img', { src: shot.dataUrl, alt: 'Screenshot Shine captured' }),
      ]);
      if (shot.path) {
        card.appendChild(
          el('button', {
            class: 'shine-image-download',
            type: 'button',
            text: 'Show in folder',
            onclick: function () { D.app.showItemInFolder(shot.path); },
          })
        );
      }
      insertAfter(afterNode, el('div', { class: 'message assistant shine-desktop-note' }, [card]));
    });
  }

  function appendToolSummary(tools, afterNode) {
    var rows = tools.map(function (t) {
      var detail = t.summary ? ' - ' + escapeHtml(String(t.summary).split('\n')[0].slice(0, 110)) : '';
      return '<li><code>' + escapeHtml(t.tool) + '</code>' + detail + '</li>';
    });
    insertAfter(afterNode, el('div', { class: 'message assistant shine-desktop-note' }, [
      el('div', {
        class: 'shine-tool-summary',
        html:
          '<p><strong>' + tools.length + ' PC action' + (tools.length === 1 ? '' : 's') + '</strong></p>' +
          '<ul>' + rows.join('') + '</ul>',
      }),
    ]));
  }

  /* ======================================================================
     Window bar
     ====================================================================== */

  var Titlebar = (function () {
    var bar = null;
    var pcBtn = null;
    var accountName = null;

    function textButton(label, title, onClick) {
      return el('button', { class: 'shine-tb-btn', type: 'button', title: title, text: label, onclick: onClick });
    }

    function windowButton(glyph, title, onClick, extraClass) {
      return el('button', {
        class: 'shine-tb-winbtn' + (extraClass ? ' ' + extraClass : ''),
        type: 'button',
        title: title,
        'aria-label': title,
        onclick: onClick,
      }, [svg(GLYPH[glyph])]);
    }

    function build() {
      if (bar && document.body.contains(bar)) return bar;

      pcBtn = textButton('Control PC', 'Let Shine operate this computer', function () {
        Agent.toggle();
      });

      bar = el('div', { class: 'shine-titlebar' }, [
        el('div', { class: 'shine-tb-title', text: 'Shine' }),
        accountName = el('button', {
          class: 'shine-tb-btn shine-tb-account',
          type: 'button',
          title: 'Sign in or open your account',
          onclick: function () { Account.toggle(); },
        }, [svg(GLYPH.user)]),
        el('div', { class: 'shine-tb-spacer' }),
        pcBtn,
        textButton('Log', 'What Shine has done on this computer', function () {
          Log.open();
        }),
        el('span', { class: 'shine-tb-sep' }),
        el('div', { class: 'shine-tb-win' }, [
          windowButton('minimize', 'Minimise', function () { D.window.minimize(); }),
          windowButton('maximize', 'Maximise', function () { D.window.toggleMaximize(); }),
          windowButton('close', 'Close Shine', function () { D.window.quit(); }, 'exit'),
        ]),
      ]);

      bar.addEventListener('dblclick', function (event) {
        if (event.target.closest('.shine-tb-winbtn') || event.target.closest('.shine-tb-btn')) return;
        D.window.toggleMaximize();
      });

      document.body.appendChild(bar);
      return bar;
    }

    function setPcState(enabled) {
      if (!pcBtn) return;
      pcBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      pcBtn.textContent = enabled ? 'PC on' : 'Control PC';
      pcBtn.title = enabled ? 'Shine can operate this computer. Click to turn it off.' : 'Let Shine operate this computer';
    }

    /* ------------------------------------------------------------------
       The window bar shows the profile picture, or a plain user glyph
       when there is not one. No name is ever displayed in the bar.
       ------------------------------------------------------------------ */
    var accountAvatar = null;

    function setAccount(account) {
      if (!accountName) return;
      accountName.title = account
        ? 'Your account'
        : 'Sign in or create an account';

      accountAvatar = null;

      if (!account || !account.hasAvatar) {
        accountName.innerHTML = '';
        accountName.appendChild(svg(GLYPH.user));
        accountName.classList.remove('has-picture');
        return;
      }

      D.account.avatar(account.username, 64).then(function (result) {
        if (!result || !result.ok) return;
        accountName.innerHTML = '';
        accountName.classList.add('has-picture');
        accountAvatar = el('img', { src: result.dataUrl, alt: 'Your profile picture' });
        accountName.appendChild(accountAvatar);
      });
    }

    function refreshWindowState(state) {
      if (!state || !bar) return;
      var maxBtn = bar.querySelectorAll('.shine-tb-winbtn')[1];
      if (maxBtn) {
        maxBtn.innerHTML = '';
        maxBtn.appendChild(svg(state.maximized ? GLYPH.restore : GLYPH.maximize));
        maxBtn.title = state.maximized ? 'Restore' : 'Maximise';
      }
    }

    return { build: build, setPcState: setPcState, setAccount: setAccount, refreshWindowState: refreshWindowState };
  })();

  /* ======================================================================
     Accounts
     ====================================================================== */

  var Account = (function () {
    var current = null;

    function field(label, type, attrs) {
      var input = el('input', Object.assign({ class: 'shine-input', type: type || 'text', autocomplete: 'off' }, attrs || {}));
      var wrap = el('div', { class: 'shine-field' }, [el('div', { class: 'shine-field-label', text: label }), input]);
      wrap.input = input;
      return wrap;
    }

    function note(text) {
      return el('div', { class: 'shine-hint', text: text });
    }

    function error(text) {
      return el('div', { class: 'shine-hint', style: { color: '#ffffff', opacity: '0.85' }, text: text });
    }

    /* ---------- sign in / sign up ---------- */

    function openAuth(mode) {
      var isSignup = mode === 'signup';
      var box = el('div');
      var message = el('div');

      var username = field('Username', 'text', { placeholder: 'at least 3 characters' });
      var password = field('Password', 'password', { placeholder: isSignup ? 'at least 8 characters' : '' });

      var displayName = isSignup ? field('Your name', 'text', { placeholder: 'What should Shine call you?' }) : null;
      var question = isSignup ? field('Recovery question', 'text', { placeholder: 'Used if you forget your password' }) : null;
      var answer = isSignup ? field('Answer', 'text', { placeholder: 'Keep this somewhere safe' }) : null;

      box.appendChild(username);
      if (displayName) box.appendChild(displayName);
      box.appendChild(password);
      if (question) box.appendChild(question);
      if (answer) box.appendChild(answer);
      box.appendChild(message);

      box.appendChild(
        note(
          isSignup
            ? 'This account lives only on this PC. There is no server, so nobody else can sign in as you, and a made-up username and password will never work.'
            : 'Only accounts created on this PC can be signed into.'
        )
      );

      var submit = el('button', { class: 'shine-btn primary', type: 'button', text: isSignup ? 'Create account' : 'Sign in' });

      var api = Modal.open({
        title: isSignup ? 'Create an account' : 'Sign in',
        sub: isSignup ? 'Shine will remember your name and profile picture.' : '',
        render: function (body) {
          body.appendChild(box);
        },
        footer: function (foot, modal) {
          foot.appendChild(
            el('button', {
              class: 'shine-btn ghost',
              type: 'button',
              text: isSignup ? 'Sign in instead' : 'Create an account',
              onclick: function () {
                modal.close();
                openAuth(isSignup ? 'signin' : 'signup');
              },
            })
          );
          foot.appendChild(
            el('button', {
              class: 'shine-btn ghost',
              type: 'button',
              text: 'Forgot password',
              onclick: function () {
                modal.close();
                openForgot();
              },
            })
          );
          foot.appendChild(el('span', { class: 'grow' }));
          foot.appendChild(submit);
        },
      });

      submit.addEventListener('click', async function () {
        message.innerHTML = '';
        submit.disabled = true;
        submit.textContent = 'Working...';
        var payload = { username: username.input.value.trim(), password: password.input.value };
        if (isSignup) {
          payload.displayName = displayName.input.value.trim();
          payload.recoveryQuestion = question.input.value.trim();
          payload.recoveryAnswer = answer.input.value.trim();
        }

        var result = await (isSignup ? D.account.signup(payload) : D.account.signin(payload));
        submit.disabled = false;
        submit.textContent = isSignup ? 'Create account' : 'Sign in';

        if (!result.ok) {
          message.appendChild(error(result.error));
          return;
        }
        current = result.account;
        api.close();
        refreshTitle();
        ToastHost.show(isSignup ? 'Account created' : 'Signed in', result.account.displayName);
      });
    }

    /* ---------- forgot password ---------- */

    function openForgot() {
      var username = field('Username', 'text');
      var questionRow = el('div', { style: { display: 'none' } });
      var questionLabel = el('div', { class: 'shine-field-label', text: 'Recovery question' });
      var questionText = el('div', { class: 'shine-hint' });
      var answer = field('Your answer', 'text');
      var newPassword = field('New password', 'password');
      var message = el('div');

      var answerWrap = el('div', { style: { display: 'none' } }, [answer, newPassword]);
      questionRow.appendChild(questionLabel);
      questionRow.appendChild(questionText);
      questionRow.appendChild(answerWrap);

      var box = el('div', {}, [username, questionRow, message]);
      box.appendChild(note('Answer your recovery question to set a new password.'));

      var submit = el('button', { class: 'shine-btn primary', type: 'button', text: 'Continue' });
      var stage = 1;

      var api = Modal.open({
        title: 'Forgot password',
        sub: 'Recover the account on this PC.',
        render: function (body) {
          body.appendChild(box);
        },
        footer: function (foot, modal) {
          foot.appendChild(
            el('button', { class: 'shine-btn ghost', type: 'button', text: 'Back to sign in', onclick: function () { modal.close(); openAuth('signin'); } })
          );
          foot.appendChild(el('span', { class: 'grow' }));
          foot.appendChild(submit);
        },
      });

      submit.addEventListener('click', async function () {
        message.innerHTML = '';
        submit.disabled = true;

        if (stage === 1) {
          var found = await D.account.recoveryQuestion(username.input.value.trim());
          submit.disabled = false;
          if (!found.ok) {
            message.appendChild(error(found.error));
            return;
          }
          questionText.textContent = found.question;
          questionRow.style.display = '';
          answerWrap.style.display = '';
          stage = 2;
          submit.textContent = 'Set new password';
          return;
        }

        var result = await D.account.forgot({
          username: username.input.value.trim(),
          answer: answer.input.value.trim(),
          newPassword: newPassword.input.value,
        });
        submit.disabled = false;

        if (!result.ok) {
          message.appendChild(error(result.error));
          return;
        }
        current = result.account;
        api.close();
        refreshTitle();
        ToastHost.show('Password changed', 'Signed in as ' + result.account.username);
      });
    }

    /* ---------- account settings ---------- */

    function open() {
      var box = el('div');
      var message = el('div');

      function label(text) {
        return el('div', { class: 'shine-field-label', style: { marginTop: '18px' }, text: text });
      }

      var avatarBox = el('div', { style: { display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '6px' } });
      var avatarImg = el('div', { class: 'shine-avatar', text: 'none' });
      avatarBox.appendChild(avatarImg);

      var avatarButtons = el('div', { style: { display: 'flex', gap: '8px' } }, [
        el('button', {
          class: 'shine-btn',
          type: 'button',
          text: 'Change picture',
          onclick: async function () {
            var result = await D.account.chooseAvatar(current.username);
            if (result.cancelled) return;
            if (!result.ok) return ToastHost.show('Could not use that image', result.error, 7000);
            current = result.account;
            refreshTitle();
            paint();
            ToastHost.show('Profile picture updated', '', 2600);
          },
        }),
        el('button', {
          class: 'shine-btn ghost',
          type: 'button',
          text: 'Remove',
          onclick: async function () {
            var result = await D.account.clearAvatar(current.username);
            if (!result.ok) return ToastHost.show('Could not remove that', result.error, 6000);
            current = result.account;
            refreshTitle();
            paint();
          },
        }),
      ]);
      avatarBox.appendChild(avatarButtons);

      var nameField = field('Your name', 'text');
      var usernameField = field('Username', 'text');

      var currentPassword = field('Current password', 'password');
      var newPassword = field('New password', 'password');
      var usernamePassword = field('Your password', 'password');
      var newUsername = field('New username', 'text');

      box.appendChild(label('Profile picture'));
      box.appendChild(avatarBox);
      box.appendChild(label('Your details'));
      box.appendChild(nameField);
      box.appendChild(usernameField);
      box.appendChild(el('div', { class: 'shine-hint', text: 'Shine tells the AI your name and username so it can answer questions about you. With a picture set, the AI can describe it too.' }));

      box.appendChild(label('Change your password'));
      box.appendChild(currentPassword);
      box.appendChild(newPassword);
      box.appendChild(
        el('button', {
          class: 'shine-btn',
          type: 'button',
          text: 'Change password',
          onclick: async function () {
            message.innerHTML = '';
            var result = await D.account.changePassword({
              username: current.username,
              currentPassword: currentPassword.input.value,
              newPassword: newPassword.input.value,
            });
            if (!result.ok) return message.appendChild(error(result.error));
            currentPassword.input.value = '';
            newPassword.input.value = '';
            message.appendChild(el('div', { class: 'shine-hint', text: 'Password changed.' }));
          },
        })
      );

      box.appendChild(label('Change your username'));
      box.appendChild(newUsername);
      box.appendChild(usernamePassword);
      box.appendChild(
        el('button', {
          class: 'shine-btn',
          type: 'button',
          text: 'Change username',
          onclick: async function () {
            message.innerHTML = '';
            var result = await D.account.changeUsername({
              username: current.username,
              newUsername: newUsername.input.value.trim(),
              password: usernamePassword.input.value,
            });
            if (!result.ok) return message.appendChild(error(result.error));
            current = result.account;
            nameField.input.value = current.displayName || '';
            newUsername.input.value = '';
            usernamePassword.input.value = '';
            refreshTitle();
            paint();
            message.appendChild(el('div', { class: 'shine-hint', text: 'Username changed to ' + current.username + '.' }));
          },
        })
      );

      box.appendChild(message);

      function paint() {
        nameField.input.value = current.displayName || '';
        usernameField.input.value = current.username;
        if (current.hasAvatar) {
          D.account.avatar(current.username, 128).then(function (result) {
            if (result.ok) {
              avatarImg.innerHTML = '';
              avatarImg.appendChild(el('img', { src: result.dataUrl, alt: 'Profile picture', style: { width: '100%', height: '100%', objectFit: 'cover' } }));
            }
          });
        } else {
          avatarImg.textContent = 'none';
        }
      }

      Modal.open({
        title: 'Account',
        sub: 'Stored on this PC only.',
        render: function (body) {
          body.appendChild(box);
          paint();
        },
        footer: function (foot, api) {
          foot.appendChild(
            el('button', {
              class: 'shine-btn ghost',
              type: 'button',
              text: 'Sign out',
              onclick: async function () {
                await D.account.signout();
                current = null;
                refreshTitle();
                api.close();
                ToastHost.show('Signed out', '', 2400);
              },
            })
          );
          foot.appendChild(el('span', { class: 'grow' }));
          foot.appendChild(el('button', { class: 'shine-btn primary', type: 'button', text: 'Done', onclick: api.close }));
        },
      });
    }

    function toggle() {
      if (current) open();
      else openAuth('signin');
    }

    function refreshTitle() {
      Titlebar.setAccount(current);
      installAskWrapper();
    }

    function load() {
      return D.account.current().then(function (account) {
        current = account;
        refreshTitle();
        return current;
      });
    }

    /** Re-wrap ask() after a sign-in or sign-out. */
    function refresh() {
      installAskWrapper();
    }

    return { load: load, refresh: refresh, toggle: toggle, get current() { return current; } };
  })();

  /* ======================================================================
     Activity log
     ====================================================================== */

  var Log = (function () {
    function open() {
      Modal.open({
        title: 'Activity log',
        sub: 'Everything Shine did on this computer, newest first.',
        render: function (body) {
          var box = el('div', { class: 'shine-log' }, [el('div', { class: 'shine-empty', text: 'Loading...' })]);
          body.appendChild(box);

          D.log.list(200).then(function (rows) {
            box.innerHTML = '';
            if (!rows || !rows.length) {
              box.appendChild(el('div', { class: 'shine-empty', text: 'Shine has not run anything on this computer yet.' }));
              return;
            }
            rows.forEach(function (row) {
              var time = '';
              try {
                time = new Date(row.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
              } catch (e) {
                time = '';
              }
              var what = String(row.summary || row.reason || row.detail || '');
              box.appendChild(
                el('div', { class: 'shine-log-row' }, [
                  el('span', { class: 'shine-log-time', text: time }),
                  el('span', { class: 'shine-log-tool', text: row.tool || '-', title: row.decision || '' }),
                  el('span', { class: 'shine-log-what', text: what, title: what }),
                ])
              );
            });
          });
        },
        footer: function (foot, api) {
          foot.appendChild(
            el('button', {
              class: 'shine-btn',
              type: 'button',
              text: 'Clear',
              onclick: function () {
                D.log.clear().then(function () {
                  api.close();
                  ToastHost.show('Log cleared', '', 2000);
                });
              },
            })
          );
          foot.appendChild(el('span', { class: 'grow' }));
          foot.appendChild(el('button', { class: 'shine-btn primary', type: 'button', text: 'Close', onclick: api.close }));
        },
      });
    }

    return { open: open };
  })();

  /* ======================================================================
     Approval dialog
     ====================================================================== */

  var Approvals = (function () {
    var queue = [];
    var current = null;

    var RISK_LABEL = { read: 'Read only', write: 'Write', exec: 'Run command', system: 'System' };

    function handle(request) {
      queue.push(request);
      if (!current) next();
    }

    function next() {
      if (current || !queue.length) return;
      current = queue.shift();
      show(current);
    }

    function show(request) {
      var settled = false;

      function settle(decision) {
        if (settled) return;
        settled = true;
        if (request.id) D.pc.respondToApproval(request.id, decision);
        current = null;
        setTimeout(next, 120);
      }

      var prefix = '';
      if (request.name === 'run_command') {
        prefix = String(request.summary || '').trim().split(/\s+/)[0] || '';
      }

      var ruleInput = null;

      Modal.open({
        title: request.name.replace(/_/g, ' '),
        sub: (RISK_LABEL[request.risk] || request.risk) + (request.purpose ? ' - ' + request.purpose : ''),
        render: function (body) {
          body.appendChild(el('div', { text: 'Shine wants to run this on your computer:' }));
          body.appendChild(el('pre', { class: 'shine-code', text: request.summary || '(no arguments)' }));

          if (request.args && request.args.content) {
            body.appendChild(el('div', { class: 'shine-hint', text: 'File content:' }));
            body.appendChild(el('pre', { class: 'shine-code', text: String(request.args.content).slice(0, 600) }));
          }

          var notes = [];
          (request.warnings || []).forEach(function (w) { notes.push(w); });
          if (request.risk === 'exec' && prefix) {
            notes.push('If you choose "always allow", Shine will not ask again for commands starting with "' + prefix + '".');
          }
          if (notes.length) {
            var list = el('ul', { class: 'shine-notes' });
            notes.forEach(function (line) { list.appendChild(el('li', { text: line })); });
            body.appendChild(list);
          }

          if (request.risk === 'exec' && prefix) {
            ruleInput = el('input', { type: 'text', value: prefix, spellcheck: 'false' });
            body.appendChild(
              el('label', { class: 'shine-remember' }, [
                el('span', { text: 'Always allow commands starting with' }),
                ruleInput,
              ])
            );
          }
        },
        footer: function (foot, api) {
          foot.appendChild(el('button', { class: 'shine-btn danger', type: 'button', text: 'Deny', onclick: function () { settle({ approved: false }); api.close(); } }));
          foot.appendChild(el('span', { class: 'grow' }));
          foot.appendChild(el('button', { class: 'shine-btn', type: 'button', text: 'Allow once', onclick: function () { settle({ approved: true }); api.close(); } }));
          foot.appendChild(
            el('button', {
              class: 'shine-btn primary',
              type: 'button',
              text: 'Always allow',
              onclick: function () {
                if (request.risk === 'exec' && prefix) {
                  var pattern = (ruleInput && ruleInput.value.trim()) || prefix;
                  settle({ approved: true, remember: true, rule: { pattern: pattern, match: 'prefix', tool: request.name } });
                } else {
                  settle({
                    approved: true,
                    remember: true,
                    rule: { pattern: String(request.summary || '').trim(), match: 'equals', tool: request.name },
                  });
                }
                api.close();
              },
            })
          );
        },
        onClose: function () {
          // Escape or a backdrop click means "deny" - never silently allow.
          settle({ approved: false, reason: 'The request was dismissed.' });
        },
      });
    }

    return { handle: handle };
  })();

  /* ======================================================================
     PC Control agent bridge
     ====================================================================== */

  var Agent = (function () {
    var state = { enabled: false, busy: false, status: null };

    var PROVIDER_RULES = [
      { id: 'openai', test: /api\.openai\.com\/v1\/chat\/completions/i },
      { id: 'claude', test: /api\.anthropic\.com\/v1\/messages/i },
      { id: 'gemini', test: /generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:generateContent/i },
      { id: 'groq', test: /api\.groq\.com\/openai\/v1\/chat\/completions/i },
      { id: 'openrouter', test: /openrouter\.ai\/api\/v1\/chat\/completions/i },
      { id: 'grok', test: /api\.x\.ai\/v1\/chat\/completions/i },
      { id: 'bazaarlink', test: /api\.bazaarlink\.ai\/v1\/chat\/completions/i },
    ];

    function matchProvider(url) {
      for (var i = 0; i < PROVIDER_RULES.length; i += 1) {
        if (PROVIDER_RULES[i].test.test(url)) return PROVIDER_RULES[i].id;
      }
      // Anything else shaped like an OpenAI chat endpoint is the site's
      // "Custom AI" provider.
      if (/\/chat\/completions(\?|$)/i.test(url)) return 'custom';
      return null;
    }

    function headerValue(headers, name) {
      if (!headers) return '';
      try {
        if (typeof headers.get === 'function') return headers.get(name) || '';
        if (typeof headers === 'object') {
          var lower = name.toLowerCase();
          var keys = Object.keys(headers);
          for (var i = 0; i < keys.length; i += 1) {
            if (keys[i].toLowerCase() === lower) return headers[keys[i]];
          }
        }
      } catch (e) {
        /* fall through */
      }
      return '';
    }

    function textFromBody(provider, body) {
      try {
        if (provider === 'gemini') {
          var contents = body.contents || [];
          for (var i = contents.length - 1; i >= 0; i -= 1) {
            var parts = (contents[i] && contents[i].parts) || [];
            var text = parts
              .filter(function (p) { return typeof p.text === 'string'; })
              .map(function (p) { return p.text; })
              .join('\n');
            if (text.trim()) return text.trim();
          }
          return '';
        }
        var messages = body.messages || [];
        for (var j = messages.length - 1; j >= 0; j -= 1) {
          if (messages[j].role !== 'user') continue;
          var content = messages[j].content;
          if (typeof content === 'string') return content.trim();
          if (Array.isArray(content)) {
            var joined = content
              .filter(function (c) { return c && c.type === 'text' && typeof c.text === 'string'; })
              .map(function (c) { return c.text; })
              .join('\n');
            if (joined.trim()) return joined.trim();
          }
        }
        return '';
      } catch (e) {
        return '';
      }
    }

    function synthesize(provider, text) {
      if (provider === 'gemini') {
        return { candidates: [{ content: { parts: [{ text: text }], role: 'model' }, finishReason: 'STOP' }] };
      }
      if (provider === 'claude') {
        return { id: 'msg_shine_desktop', type: 'message', role: 'assistant', content: [{ type: 'text', text: text }], stop_reason: 'end_turn' };
      }
      return {
        id: 'chatcmpl-shine-desktop',
        object: 'chat.completion',
        model: 'shine-desktop',
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      };
    }

    function jsonResponse(data, status) {
      return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    async function chat(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var provider = matchProvider(url);
      if (!provider || !state.enabled) return null;

      var method = ((init && init.method) || 'GET').toUpperCase();
      if (method !== 'POST') return null;

      var body = null;
      try {
        if (init && typeof init.body === 'string') body = JSON.parse(init.body);
      } catch (e) {
        return null;
      }
      if (!body) return null;

      var headers = (init && init.headers) || (input && input.headers);
      var authz = headerValue(headers, 'authorization');
      var xapikey = headerValue(headers, 'x-api-key');
      var key = '';
      if (authz) key = authz.replace(/^Bearer\s+/i, '').trim();
      if (!key && xapikey) key = xapikey;
      if (!key && provider === 'gemini') {
        try {
          key = new URL(url).searchParams.get('key') || '';
        } catch (e) {
          /* noop */
        }
      }
      if (!key) return null;

      var query = textFromBody(provider, body);
      if (!query) return null;

      var model = body.model;
      if (!model && provider === 'gemini') {
        var m = /models\/([^:]+):generateContent/i.exec(url);
        model = m ? decodeURIComponent(m[1]) : '';
      }
      if (!model) return null;

      var ai = ShineStore.ai();

      setBusy(true);
      try {
        var result = await D.pc.run({
          provider: provider,
          model: model,
          apiKey: key,
          baseUrl: provider === 'custom' ? ai.custom?.baseUrl : '',
          authStyle: provider === 'custom' ? ai.custom?.authStyle || 'bearer' : 'bearer',
          query: query,
          history: readHistory(8).filter(function (turn) { return turn.text !== query; }),
          systemContext: 'The active AI provider is ' + provider + '.',
        });

        if (!result || !result.ok) {
          var message = (result && result.error) || 'PC Control could not complete the request.';
          ToastHost.show('PC Control stopped', message, 9000);
          return jsonResponse(synthesize(provider, 'I could not complete that: ' + message));
        }

        // Shine renders this response itself, so the text is not injected
        // again here. Anything extra waits until that reply has landed.
        afterAssistantReply(result.text, function (node) {
          if (result.screenshots && result.screenshots.length) appendScreenshots(result.screenshots, node);
          if (result.toolsUsed && result.toolsUsed.length) appendToolSummary(result.toolsUsed, node);
        });

        return jsonResponse(synthesize(provider, result.text));
      } catch (err) {
        ToastHost.show('PC Control error', (err && err.message) || String(err), 9000);
        return jsonResponse(synthesize(provider, 'PC Control hit an error: ' + ((err && err.message) || err)));
      } finally {
        setBusy(false);
      }
    }

    function setBusy(busy) {
      state.busy = busy;
      Titlebar.setPcState(state.enabled);
    }

    /* ------------------------------------------------------------------
       Dictation

       The site's composer already has a microphone button. When it is pressed
       the site records audio and posts it to a Whisper transcription
       endpoint. That request is rerouted through the main process, which
       knows about OpenAI, Groq and any custom endpoint as well as the fully
       offline model. The site receives a normal { text } response either way,
       so the transcript lands in the chat box exactly as the site intends.
       ------------------------------------------------------------------ */

    function blobToBase64(blob) {
      return blob.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        var binary = '';
        var STEP = 0x8000;
        for (var i = 0; i < bytes.length; i += STEP) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
        }
        return btoa(binary);
      });
    }

    async function transcribe(input, init) {
      var body = init && init.body;
      if (!body || typeof body.get !== 'function') return null; // not FormData

      var file = body.get('file');
      if (!file || typeof file.arrayBuffer !== 'function') return null;

      try {
        var audioBase64 = await blobToBase64(file);
        var result = await D.mic.transcribe({ audioBase64: audioBase64, credentials: ShineStore.sttCredentials() });
        if (result && result.ok) return jsonResponse({ text: result.text });
        return jsonResponse({ error: { message: (result && result.error) || 'Transcription failed.' } }, 400);
      } catch (err) {
        return jsonResponse({ error: { message: (err && err.message) || 'Transcription failed.' } }, 400);
      }
    }

    function enabled() {
      return state.enabled;
    }

    async function toggle() {
      if (state.enabled) {
        state.enabled = false;
        Titlebar.setPcState(false);
        await D.pc.setEnabled(false);
        ToastHost.show('PC Control off', 'Shine will not touch your computer.', 2600);
        return;
      }

      var ai = ShineStore.ai();
      if (!ai.activeProvider) {
        ToastHost.show('No AI provider', 'Open Shine Settings and add an API key first.', 7000);
        return;
      }

      var supported = await D.pc.isSupportedProvider(ai.activeProvider);
      if (!supported.supported) {
        ToastHost.show('Provider not supported', 'Use ChatGPT, Claude, Gemini, Groq, OpenRouter, Grok or a Custom endpoint.', 7000);
        return;
      }

      state.enabled = true;
      Titlebar.setPcState(true);
      await D.pc.setEnabled(true);
      ToastHost.show('Control PC is on', 'Shine will ask before every action.', 4000);
    }

    function applyStatus(status) {
      if (!status) return;
      state.status = status;
      state.enabled = !!status.enabled;
      Titlebar.setPcState(state.enabled);
    }

    function install() {
      var nativeFetch = window.fetch;
      if (nativeFetch.__shineWrapped) return;

      var wrapped = function (input, init) {
        // Only requests we could actually take over go down the async path.
        // Everything else must stay a plain pass-through.
        if (!shouldHandle(input)) return nativeFetch.apply(this, arguments);
        var ctx = this;
        var args = arguments;
        return handle(input, init).then(function (result) {
          return result || nativeFetch.apply(ctx, args);
        });
      };

      wrapped.__shineWrapped = true;
      window.fetch = wrapped;
    }

    function shouldHandle(input) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/audio\/transcriptions/i.test(url)) return true;
      if (!matchProvider(url)) return false;
      if (/\/(images|audio)\//i.test(url)) return false;
      // A local or custom http:// provider cannot be reached from an https
      // page at all, so those are sent through the main process instead.
      if (/^http:\/\//i.test(url)) return true;
      return true;
    }

    function handle(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/\/audio\/transcriptions/i.test(url)) return transcribe(input, init);

      // PC Control takes over when it is on.
      if (state.enabled) return chat(input, init);

      // Otherwise every provider request goes through the main process. That
      // removes CORS and mixed-content walls (so local models work) and is
      // where the signed-in user's profile is attached.
      if (matchProvider(url)) return proxy(input, init);
      return null;
    }

    var proxySeq = 0;

    /**
     * Replay a provider request from the main process, where it is free of the
     * browser's cross-origin and mixed-content restrictions.
     */
    async function proxy(input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var headers = {};
      var raw = (init && init.headers) || (input && input.headers);
      if (raw && typeof raw.forEach === 'function') {
        try {
          raw.forEach(function (value, key) { headers[key] = value; });
        } catch (e) {
          headers = {};
        }
      }

      proxySeq += 1;
      var id = 'proxy-' + proxySeq;
      var signal = init && init.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', function () { D.net.cancel(id); }, { once: true });
      }

      var result = await D.net.request({
        id: id,
        url: url,
        method: (init && init.method) || 'GET',
        headers: headers,
        body: init && typeof init.body === 'string' ? init.body : undefined,
        provider: matchProvider(url),
      });

      if (!result || !result.ok) {
        return new Response(
          JSON.stringify({ error: { message: (result && result.error) || 'The request failed.' } }),
          { status: result && result.cancelled ? 0 : 502, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(result.body, {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return { install: install, toggle: toggle, enabled: enabled, applyStatus: applyStatus, setBusy: setBusy };
  })();

  /* ======================================================================
     Profile context for the site's own chat

     The site calls window.ask(text) with whatever the user typed. Wrapping
     it lets the signed-in user's name and username ride along with the
     request, so both the AI providers and the site's built-in non-AI replies
     know who they are talking to. The visible message stays exactly as typed.
     ====================================================================== */

  function installAskWrapper() {
    var original = window.ask;
    if (typeof original !== 'function' || original.__shineWrapped) return;
    if (!Account.current) return;

    var wrapped = function (text, options) {
      var opts = options || {};
      var account = Account.current;
      if (!account) return original.apply(this, arguments);

      var preamble =
        '[About the person you are talking to]\n' +
        'username: ' + account.username + '\n' +
        'name: ' + (account.displayName || account.username) + '\n' +
        'profile picture: ' + (account.hasAvatar ? 'set, stored on their account' : 'none set') + '\n' +
        '[/About the person you are talking to]\n\n';

      var sent = preamble + text;
      // Keep the message the user typed as the one they see.
      var next = {};
      Object.keys(opts).forEach(function (k) { next[k] = opts[k]; });
      if (typeof next.displayMessage !== 'string') next.displayMessage = String(text || '');
      return original.call(this, sent, next);
    };

    wrapped.__shineWrapped = true;
    window.ask = wrapped;
  }

  /* ======================================================================
     Bootstrap
     ====================================================================== */

  async function start() {
    // Wait for the Shine UI so the offsets land in the right place.
    for (var i = 0; i < 60; i += 1) {
      if (document.querySelector('.composer-wrap textarea, #prompt, textarea')) break;
      await new Promise(function (r) { setTimeout(r, 100); });
    }

    Titlebar.build();
    Agent.install();

    D.window.onStateChange(Titlebar.refreshWindowState);
    D.window.state().then(Titlebar.refreshWindowState);

    D.pc.onStatusChange(Agent.applyStatus);
    D.pc.onApprovalRequest(Approvals.handle);

    D.pc.status().then(Agent.applyStatus);

    Account.load().then(installAskWrapper);
  }

  // Keep the window bar alive if the page replaces its document.
  var observer = null;
  function watchDom() {
    if (observer || !document.body) return;
    observer = new MutationObserver(function () {
      if (!document.querySelector('.shine-titlebar')) Titlebar.build();
    });
    observer.observe(document.body, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchDom);
  } else {
    watchDom();
  }

  start().catch(function (err) {
    console.error('[shine-desktop] startup failed:', err);
  });

  window.__shineDesktop = {
    toast: ToastHost.show,
    agent: Agent,
    log: Log,
    account: Account,
    installAskWrapper: installAskWrapper,
  };
  window.__shineDesktopUi = true;
})();
