// TypeScript - Vite will bundle + transpile this
const greeting: string = 'running in native WebView via Vite';
console.log(`[window-this] ${greeting}`);
console.log('[window-this] platform:', navigator.platform);
