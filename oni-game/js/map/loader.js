// Google Maps JavaScript API の読み込み
// APIキーはソースに書かず、config/config.js（Git管理外）から受け取る。

let loading = null;

export function loadGoogleMaps(apiKey, { timeoutMs = 10000 } = {}) {
  if (window.google?.maps?.importLibrary) return Promise.resolve(window.google.maps);
  if (loading) return loading;

  loading = new Promise((resolve, reject) => {
    const callbackName = '__oniGoogleMapsReady';
    const timer = setTimeout(() => reject(new Error('Google Maps の読み込みがタイムアウトしました')), timeoutMs);

    window[callbackName] = () => {
      clearTimeout(timer);
      delete window[callbackName];
      resolve(window.google.maps);
    };

    const params = new URLSearchParams({
      key: apiKey,
      v: 'weekly',
      loading: 'async',
      callback: callbackName,
      language: 'ja',
      region: 'JP',
    });
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Google Maps を読み込めませんでした'));
    };
    document.head.append(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });

  return loading;
}
