/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./src/webviewers/log-viewer/**/*.{html,ts,tsx}",
    "./src/shared/**/*.ts"
  ],
  corePlugins: { preflight: false },
  prefix: "tw-",
  important: "#app",
  theme: {
    extend: {
      borderRadius: { 'xl2': '1rem' },
    }
  }
};
