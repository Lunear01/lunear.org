import { useEffect, useState } from "react";

const DISMISS_KEY = "lunear-install-hint-dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // ignore storage failures (private browsing, quota, etc.)
  }
}

function isIosSafari(): boolean {
  const ua = window.navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua);
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  return isIos && isSafari;
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as { standalone?: boolean }).standalone === true
  );
}

export function InstallHint() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  useEffect(() => {
    if (dismissed || isStandalone()) return;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    if (isIosSafari()) {
      setShowIosHint(true);
    }

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, [dismissed]);

  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
    setDeferredPrompt(null);
    setShowIosHint(false);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    dismiss();
  };

  if (dismissed) return null;

  if (deferredPrompt) {
    return (
      <div className="install-hint">
        <span>Install Lunear Games for quicker access.</span>
        <div className="install-hint__actions">
          <button type="button" className="button button--small button--primary" onClick={() => void install()}>
            Install
          </button>
          <button type="button" className="button button--small button--ghost" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  if (showIosHint) {
    return (
      <div className="install-hint">
        <span>Add Lunear Games to your Home Screen: tap Share, then "Add to Home Screen".</span>
        <div className="install-hint__actions">
          <button type="button" className="button button--small button--ghost" onClick={dismiss}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return null;
}
