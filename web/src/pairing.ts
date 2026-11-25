const storageKey = "rosegold-viewer.pairing-secret";
const secretPattern = /^[0-9a-f]{64}$/i;

export function bindPairingForm(
  form: HTMLFormElement,
  input: HTMLInputElement,
  remember: HTMLInputElement,
  attach: (secret: string) => void,
  invalid: () => void,
) {
  function forget() {
    try { window.localStorage.removeItem(storageKey); } catch {}
  }

  function submit() {
    const secret = input.value.trim();
    input.value = "";
    if (secretPattern.test(secret)) attach(secret.toLowerCase());
    else invalid();
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    submit();
  });
  remember.addEventListener("change", () => {
    if (!remember.checked) forget();
  });

  return {
    restore() {
      let saved: string | null;
      try { saved = window.localStorage.getItem(storageKey); } catch { return; }
      if (saved === null) return;
      if (!secretPattern.test(saved)) {
        forget();
        return;
      }
      input.value = saved;
      remember.checked = true;
      submit();
    },
    paired(secret: string) {
      if (!remember.checked) return;
      try { window.localStorage.setItem(storageKey, secret); } catch {}
    },
    rejected() {
      remember.checked = false;
      forget();
    },
  };
}
