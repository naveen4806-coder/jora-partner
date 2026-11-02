/* Browser-safe shared API address. Do not add database credentials here. */
window.JORA_API_CONFIG = { url: localStorage.getItem('jora_api_url') || 'http://127.0.0.1:4000/api' };
