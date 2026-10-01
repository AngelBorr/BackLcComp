import { buildTransactionalEmailLayout, escapeHtml } from './transactionalEmailLayout.js'

export const buildEmailVerificationTemplate = ({ firstName, verificationUrl }) => {
  const safeName = escapeHtml(firstName || 'cliente')
  const safeVerificationUrl = escapeHtml(verificationUrl)
  const subject = 'Verificá tu correo electrónico'

  const html = buildTransactionalEmailLayout({
    title: subject,
    preheader: 'Confirmá tu correo para completar la verificación de tu cuenta LC COMP.',
    content: `
      <h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;color:#166534;">${subject}</h1>
      <p style="margin:0 0 16px;">Hola ${safeName},</p>
      <p style="margin:0 0 22px;">Confirmá que tenés acceso a esta casilla de correo haciendo clic en el siguiente botón:</p>
      <p style="margin:0 0 24px;text-align:center;">
        <a href="${safeVerificationUrl}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px;">Verificar mi correo</a>
      </p>
      <p style="margin:0 0 16px;">Este enlace tiene una vigencia de 24 horas y puede utilizarse una sola vez.</p>
      <p style="margin:0 0 8px;">Si el botón no funciona, copiá y pegá este enlace en tu navegador:</p>
      <p style="margin:0 0 20px;word-break:break-all;"><a href="${safeVerificationUrl}" style="color:#166534;">${safeVerificationUrl}</a></p>
      <p style="margin:0;color:#6b7280;font-size:14px;">Si no creaste una cuenta en LC COMP, podés ignorar este mensaje.</p>
    `
  })

  const text = [
    subject,
    '',
    `Hola ${firstName || 'cliente'},`,
    '',
    'Confirmá que tenés acceso a esta casilla de correo ingresando al siguiente enlace:',
    verificationUrl,
    '',
    'Este enlace tiene una vigencia de 24 horas y puede utilizarse una sola vez.',
    '',
    'Si no creaste una cuenta en LC COMP, podés ignorar este mensaje.'
  ].join('\n')

  return { subject, html, text }
}
