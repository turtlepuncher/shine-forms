/**
 * Shine Forms — i18n (bilingual support)
 *
 * Auto-detects browser language (defaults to Spanish for Barcelona).
 * Provides t(key) helper and language toggle.
 */

const ShineI18n = (() => {
  let _lang = 'es'; // default
  const _listeners = [];

  /** Detect from browser or URL param */
  function detect() {
    const params = new URLSearchParams(window.location.search);
    const urlLang = params.get('lang');
    if (urlLang && (urlLang === 'en' || urlLang === 'es')) {
      _lang = urlLang;
      return;
    }
    const nav = navigator.language || navigator.userLanguage || '';
    _lang = nav.startsWith('en') ? 'en' : 'es';
  }

  /** Get current language */
  function lang() {
    return _lang;
  }

  /** Set language and notify listeners */
  function setLang(l) {
    if (l !== 'en' && l !== 'es') return;
    _lang = l;
    _listeners.forEach(fn => fn(_lang));
  }

  /** Resolve a bilingual value: { en: "...", es: "..." } or plain string */
  function t(val) {
    if (!val) return '';
    if (typeof val === 'string') return val;
    return val[_lang] || val['en'] || val['es'] || '';
  }

  /** Subscribe to language changes */
  function onChange(fn) {
    _listeners.push(fn);
  }

  // Auto-detect on load
  detect();

  return { lang, setLang, t, onChange, detect };
})();
