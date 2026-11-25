// Shared email layout: inline styles and tables so it renders the same in
// Gmail, Outlook and phone clients. Every email also has a plain-text version.
const BRAND = '#21684f';
const BRAND_SOFT = '#e1efe8';
const BACKGROUND = '#f4f7f5';
const TEXT = '#17231d';
const MUTED = '#52635a';
const BORDER = '#dbe4df';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const escapeHtml = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

/*
 * renderEmail({ preheader, eyebrow, heading, intro, highlight, details, cta, outro, footer })
 * - highlight: { label, value } shown big (an amount).
 * - details: [[label, value], …] as a small table.
 * - cta: { label, url } button.
 * - footer: { text, link?: { label, url } }.
 */
export function renderEmail({ preheader = '', eyebrow, heading, intro, highlight, details = [], cta, outro, footer }) {
  const detailRows = details
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([label, value]) => `
            <tr>
              <td style="padding:6px 0;color:${MUTED};font-size:14px;">${escapeHtml(label)}</td>
              <td style="padding:6px 0;color:${TEXT};font-size:14px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
            </tr>`)
    .join('');

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${BACKGROUND};font-family:${FONT};color:${TEXT};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BACKGROUND};">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
          <tr>
            <td style="padding:0 4px 14px;">
              <table role="presentation" cellpadding="0" cellspacing="0"><tr>
                <td style="width:36px;height:36px;border-radius:10px;background:${BRAND};color:#ffffff;font-size:18px;font-weight:800;text-align:center;vertical-align:middle;">€</td>
                <td style="padding-left:10px;font-size:18px;font-weight:800;color:${TEXT};">BudgetApp</td>
              </tr></table>
            </td>
          </tr>
          <tr>
            <td style="background:#ffffff;border:1px solid ${BORDER};border-radius:18px;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr><td style="height:6px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>
                <tr>
                  <td style="padding:24px 24px 8px;">
                    ${eyebrow ? `<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${BRAND};">${escapeHtml(eyebrow)}</p>` : ''}
                    <h1 style="margin:0;font-size:22px;line-height:1.3;color:${TEXT};">${escapeHtml(heading)}</h1>
                    ${intro ? `<p style="margin:10px 0 0;font-size:15px;line-height:1.55;color:${MUTED};">${escapeHtml(intro)}</p>` : ''}
                  </td>
                </tr>
                ${highlight ? `
                <tr>
                  <td style="padding:12px 24px 4px;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND_SOFT};border-radius:14px;">
                      <tr><td style="padding:16px 18px;">
                        <p style="margin:0;font-size:13px;color:${MUTED};">${escapeHtml(highlight.label)}</p>
                        <p style="margin:4px 0 0;font-size:30px;font-weight:800;color:${TEXT};">${escapeHtml(highlight.value)}</p>
                      </td></tr>
                    </table>
                  </td>
                </tr>` : ''}
                ${detailRows ? `
                <tr>
                  <td style="padding:8px 24px 0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${BORDER};">${detailRows}
                    </table>
                  </td>
                </tr>` : ''}
                ${cta ? `
                <tr>
                  <td style="padding:20px 24px 4px;">
                    <a href="${escapeHtml(cta.url)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px;">${escapeHtml(cta.label)}</a>
                  </td>
                </tr>` : ''}
                <tr>
                  <td style="padding:16px 24px 24px;">
                    ${outro ? `<p style="margin:0;font-size:13px;line-height:1.55;color:${MUTED};">${escapeHtml(outro)}</p>` : ''}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${footer ? `
          <tr>
            <td style="padding:16px 8px 0;text-align:center;font-size:12px;line-height:1.55;color:${MUTED};">
              ${escapeHtml(footer.text)}${footer.link ? ` <a href="${escapeHtml(footer.link.url)}" style="color:${BRAND};font-weight:700;">${escapeHtml(footer.link.label)}</a>` : ''}
            </td>
          </tr>` : ''}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = [
    heading,
    intro,
    highlight ? `${highlight.label}: ${highlight.value}` : null,
    ...details.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`),
    cta ? `${cta.label}: ${cta.url}` : null,
    outro,
    footer ? `${footer.text}${footer.link ? ` ${footer.link.label}: ${footer.link.url}` : ''}` : null,
  ].filter(Boolean).join('\n\n');

  return { html, text };
}
