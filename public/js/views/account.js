// Accounts (public mode): signing up and logging in with an email address or Google, the pages that email
// links open (confirm address, reset password), the account page and logging out.
import {
  h, icon, card, toast, openModal, confirmDialog, fmtDate, plural, errorBox, loading,
} from '../util.js';
import { api } from '../api.js';
import {
  state, emit, currentUser, fmtDuration, LOCATION_LABELS,
} from '../app.js';

let fieldSeq = 0;

/** A labelled form field; the label is tied to the input so it is announced and clickable. */
function field(label, input, ...extra) {
  if (!input.id) input.id = `acct-field-${++fieldSeq}`;
  return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, ...extra);
}

const authMethods = () => (state.status && state.status.auth) || {};

/** Whether this server lets people sign in at all (by email or with Google). */
export const accountsEnabled = () => !!(authMethods().email || authMethods().google);
export const signupEnabled = () => accountsEnabled() && !!authMethods().signup;

function emailInput() {
  const input = h('input', { type: 'email', name: 'email', class: 'w-full', autocomplete: 'email', autocapitalize: 'none', required: true });
  input.spellcheck = false;
  return input;
}

const passwordInput = (autocomplete) => h('input', { type: 'password', name: 'password', class: 'w-full', autocomplete, required: true });

/** Google's "G" mark for the sign-in button. */
function googleLogo() {
  const span = document.createElement('span');
  span.innerHTML = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">'
    + '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>'
    + '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>'
    + '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>'
    + '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  return span.firstChild;
}

// Leaves the app for Google's sign-in page; the server brings the user back signed in.
const googleButton = () => h('a', { class: 'btn btn-google w-full', href: '/auth/google' }, googleLogo(), 'Continue with Google');

/** Show the log-in, sign-up or forgotten-password dialog. */
export function openAuthDialog(mode = 'login') {
  const auth = authMethods();
  const body = h('div', { class: 'auth-dialog' });
  const m = openModal({ title: '', body });
  const titleEl = m.el.querySelector('.modal-header h2');

  function show(next) {
    mode = next === 'signup' && !signupEnabled() ? 'login' : next;
    const title = { login: 'Log in', signup: 'Create an account', forgot: 'Reset your password' }[mode];
    titleEl.textContent = title;
    m.el.setAttribute('aria-label', title);
    body.replaceChildren(...(mode === 'forgot' ? forgotForm() : signInForms()));
    const first = body.querySelector('input');
    if (first) first.focus();
  }

  const link = (label, next) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => show(next) }, label);

  /** Replace the dialog content with a "check your inbox" message. */
  function sent(message, detail) {
    body.replaceChildren(
      h('div', { class: 'alert alert-success' }, icon('check', 18), h('div', { class: 'grow' }, h('p', null, message), h('p', { class: 'small muted' }, detail))),
      h('div', { class: 'row' }, link('Back to log in', 'login')));
  }

  function signInForms() {
    const signup = mode === 'signup';
    const parts = [h('p', { class: 'small muted' }, signup
      ? 'With an account you can save databases and come back to them later. The databases you are working on now stay available.'
      : 'Log in to work with the databases saved in your account. The databases you are working on now stay available.')];
    if (auth.google) {
      parts.push(googleButton());
      if (auth.email) parts.push(h('div', { class: 'auth-divider' }, h('span', null, 'or')));
    }
    if (auth.email) {
      const email = emailInput();
      const password = passwordInput(signup ? 'new-password' : 'current-password');
      const err = h('div', { class: 'small danger-text', role: 'alert' });
      const submit = h('button', { class: 'btn btn-primary w-full', type: 'submit' }, signup ? 'Sign up with email' : 'Log in');
      parts.push(h('form', {
        class: 'col',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          try {
            if (signup) {
              const r = await api('signup', { email: email.value.trim(), password: password.value });
              sent(`We sent a confirmation link to ${r.email}. Open it to finish creating your account.`,
                'The link works for 24 hours. If the email doesn\'t arrive, check your spam folder, or sign up again to get a new link.');
            } else {
              const r = await api('login', { email: email.value.trim(), password: password.value });
              m.close();
              toast(`Logged in as ${r.user.email}`, 'success');
              emit('session');
            }
          } catch (ex) {
            err.textContent = ex.message;
            if (ex.reason !== 'unverified') password.select();
          } finally {
            submit.disabled = false;
          }
        },
      },
      field('Email address', email),
      field('Password', password, signup ? h('div', { class: 'hint' }, 'At least 8 characters.') : null),
      err,
      submit));
    }
    const links = signup
      ? [link('I already have an account', 'login')]
      : [auth.email ? link('Forgot password?', 'forgot') : null, signupEnabled() ? link('Create an account', 'signup') : null];
    parts.push(h('div', { class: 'row auth-links' }, links));
    return parts;
  }

  function forgotForm() {
    const email = emailInput();
    const err = h('div', { class: 'small danger-text', role: 'alert' });
    const submit = h('button', { class: 'btn btn-primary w-full', type: 'submit' }, 'Email me a reset link');
    return [
      h('p', { class: 'small muted' }, 'Enter the email address of your account and we\'ll send you a link to choose a new password.'),
      h('form', {
        class: 'col',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          try {
            const r = await api('requestPasswordReset', { email: email.value.trim() });
            sent(`If there is an account for ${r.email}, we sent it a link to reset the password.`,
              'The link works for one hour. If the email doesn\'t arrive, check your spam folder.');
          } catch (ex) {
            err.textContent = ex.message;
          } finally {
            submit.disabled = false;
          }
        },
      }, field('Email address', email), err, submit),
      h('div', { class: 'row auth-links' }, link('Back to log in', 'login')),
    ];
  }

  show(mode);
}

/** Opened from the confirmation email (#/verify?token=…): confirm the address and sign in. */
export async function renderVerify(container, route) {
  container.replaceChildren(h('h1', null, 'Confirm your email'), loading('Confirming your email address…'));
  try {
    const r = await api('verifyEmail', { token: route.params.token });
    history.replaceState(null, '', '#/');
    toast(`Your email address is confirmed. Welcome, ${r.user.email}!`, 'success');
    emit('session');
  } catch (e) {
    container.replaceChildren(h('h1', null, 'Confirm your email'), errorBox(e),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/' }, 'Continue'),
        signupEnabled() ? h('button', { class: 'btn btn-primary', onclick: () => openAuthDialog('signup') }, 'Sign up again') : null));
  }
}

/** Opened from the password-reset email (#/reset?token=…): choose a new password. */
export function renderReset(container, route) {
  const password = passwordInput('new-password');
  const repeat = h('input', { type: 'password', class: 'w-full', autocomplete: 'new-password', required: true });
  const err = h('div', { class: 'small danger-text', role: 'alert' });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Set new password');
  const form = h('form', {
    class: 'col',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (password.value !== repeat.value) {
        err.textContent = 'The passwords do not match.';
        repeat.focus();
        return;
      }
      submit.disabled = true;
      try {
        await api('resetPassword', { token: route.params.token, password: password.value });
        history.replaceState(null, '', '#/');
        toast('Your password was changed and you are logged in. Other devices were logged out.', 'success');
        emit('session');
      } catch (ex) {
        err.textContent = ex.message;
        submit.disabled = false;
      }
    },
  },
  field('New password', password, h('div', { class: 'hint' }, 'At least 8 characters.')),
  field('Repeat the new password', repeat),
  err,
  h('div', null, submit));
  container.replaceChildren(h('h1', null, 'Choose a new password'), card({ body: form }));
  password.focus();
}

/** Log out; warn first that temporary databases will be deleted. */
export async function logOut() {
  const temp = state.databases.filter((d) => d.location === 'temp');
  if (temp.length) {
    const ok = await confirmDialog({
      title: 'Log out',
      message: h('div', null,
        h('p', null, `Logging out deletes your ${plural(temp.length, 'temporary database')}:`),
        h('p', null, h('strong', null, temp.map((d) => d.name).join(', '))),
        h('p', { class: 'muted' }, 'Save or download any you want to keep first.')),
      okLabel: 'Log out',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await api('logout');
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  history.replaceState(null, '', '#/');
  toast('You are logged out', 'success');
  emit('session');
}

export async function renderAccount(container) {
  if (!currentUser()) {
    container.replaceChildren(h('h1', null, 'Account'), card({
      body: [h('p', null, 'You are not logged in.'),
        accountsEnabled() ? h('div', { class: 'row' },
          h('button', { class: 'btn btn-primary', onclick: () => openAuthDialog('login') }, 'Log in'),
          signupEnabled() ? h('button', { class: 'btn', onclick: () => openAuthDialog('signup') }, 'Create an account') : null) : null],
    }));
    return;
  }
  const { user } = await api('account');
  const limits = state.status.limits;
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  const methods = [user.hasPassword ? h('span', { class: 'badge' }, 'Email and password') : null, user.google ? h('span', { class: 'badge' }, 'Google') : null];

  container.replaceChildren(
    h('h1', null, 'Account'),
    h('div', { class: 'grid-2' },
      card({
        title: 'Profile',
        body: [kv([
          ['Email', h('strong', null, user.email)],
          user.name ? ['Name', user.name] : null,
          ['Signs in with', h('span', { class: 'row gap-sm' }, methods)],
          ['Member since', fmtDate(user.createdAt)],
          [`${LOCATION_LABELS.saved} storage`, `${Math.round(limits.userQuota / 1048576)} MB`],
          [`${LOCATION_LABELS.temp} storage`, `${Math.round(limits.guestQuota / 1048576)} MB, deleted when you log out or after ${fmtDuration(limits.userTtl)} without activity`],
        ]),
        h('div', { class: 'row mt' }, h('button', { class: 'btn', onclick: logOut }, icon('logout', 15), 'Log out'))],
      }),
      authMethods().email ? passwordCard(user) : null),
    card({
      title: 'Danger zone',
      className: 'danger-zone',
      body: h('div', { class: 'row' },
        h('span', { class: 'grow' }, 'Delete your account and every database saved in it.'),
        h('button', { class: 'btn btn-danger solid', onclick: () => deleteAccount(user) }, icon('trash', 15), 'Delete account')),
    }));
}

/** Change the password, or set one on an account that so far only signs in with Google. */
function passwordCard(user) {
  const current = h('input', { type: 'password', autocomplete: 'current-password', class: 'w-full', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', class: 'w-full', required: true, minlength: 8 });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password', class: 'w-full', required: true });
  const err = h('div', { class: 'small danger-text', role: 'alert' });
  const form = h('form', {
    class: 'col',
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      if (next.value !== repeat.value) {
        err.textContent = 'The new passwords do not match.';
        repeat.focus();
        return;
      }
      try {
        await api('changePassword', { current: current.value, password: next.value });
        toast(user.hasPassword ? 'Password changed. You were logged out on your other devices.'
          : 'Password set. You can now also log in with your email address.', 'success');
        emit('navigate');
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  },
  user.hasPassword ? field('Current password', current)
    : h('p', { class: 'small muted' }, 'You sign in with Google. Set a password to also log in with your email address.'),
  field('New password', next, h('div', { class: 'hint' }, 'At least 8 characters.')),
  field('Repeat the new password', repeat),
  err,
  h('div', null, h('button', { class: 'btn btn-primary', type: 'submit' }, user.hasPassword ? 'Change password' : 'Set password')));
  return card({ title: user.hasPassword ? 'Change password' : 'Set a password', body: form });
}

function deleteAccount(user) {
  // Accounts without a password confirm by typing their email address instead.
  const input = user.hasPassword
    ? h('input', { type: 'password', class: 'w-full', autocomplete: 'current-password' })
    : emailInput();
  const err = h('div', { class: 'small danger-text', role: 'alert' });
  const confirm = h('button', {
    class: 'btn btn-danger solid',
    onclick: async () => {
      err.textContent = '';
      try {
        await api('deleteAccount', user.hasPassword ? { password: input.value } : { confirm: input.value });
        m.close();
        history.replaceState(null, '', '#/');
        toast('Your account was deleted', 'success');
        emit('session');
      } catch (ex) {
        err.textContent = ex.message;
      }
    },
  }, 'Delete my account');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') confirm.click(); });
  const m = openModal({
    title: 'Delete account',
    body: [
      h('p', null, 'This permanently deletes your account and all of its saved and temporary databases. It cannot be undone.'),
      field(user.hasPassword ? 'Enter your password to confirm' : `Type ${user.email} to confirm`, input),
      err,
    ],
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), confirm],
    initialFocus: input,
  });
}
