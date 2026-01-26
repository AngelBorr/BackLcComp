/** @type {import('tailwindcss').Config} */
export default {
  content: [
    // Solo los directorios donde tienes tus vistas Handlebars
    './src/views/**/*.{html,handlebars,hbs}',
    './src/layouts/**/*.{html,handlebars,hbs}',
    './src/partials/**/*.{html,handlebars,hbs}',

    // Si tienes componentes en otros directorios, agrégalos específicamente
    './src/components/**/*.{html,handlebars,hbs}',

    // Archivos HTML en public/ si los tienes
    './src/public/**/*.html',

    // Archivos JS que contengan clases Tailwind (si aplica)
    './src/public/**/*.js'
  ],
  theme: {
    extend: {
      // Tus personalizaciones aquí
    }
  },
  plugins: []
}
