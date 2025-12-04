// utils/mailer.js
const nodemailer = require("nodemailer");

// 💡 USE YOUR BREVO SMTP CREDENTIALS
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false, // STARTTLS
  auth: {
    user: process.env.BREVO_LOGIN,     // "9d4e8d001@smtp-brevo.com"
    pass: process.env.BREVO_PASSWORD,  // "QBhGkjTyKJRnOIbU"
  },
});

/**
 * Send OTP email
 * @param {string} to - receiver email
 * @param {string} code - 6-digit OTP
 * @param {string} title - optional subject
 */
async function sendOtpEmail(to, code, title = "Your Verification Code") {
  const htmlTemplate = `
    <div style="font-family: Arial, sans-serif; padding: 20px;">
      <h2 style="color:#111827;">${title}</h2>
      <p style="font-size:16px;">Use the following code to continue:</p>

      <div style="
        font-size: 38px;
        font-weight: bold;
        letter-spacing: 10px;
        margin: 20px 0;
        color:#2563eb;
      ">
        ${code}
      </div>

      <p style="font-size:14px; color:#6b7280;">
        This code will expire in 5 minutes.
      </p>

      <hr style="margin:20px 0; opacity:0.3;">
      <p style="font-size:12px; color:#9ca3af;">Research Repository • MSU-IIT</p>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: `"Research Repository" <noreply@repo-system.com>`,
      to,
      subject: title,
      html: htmlTemplate,
    });

    console.log(`📧 OTP sent to ${to}`);
  } catch (err) {
    console.error("❌ OTP email failed:", err);
    throw err;
  }
}

module.exports = {
  sendOtpEmail,
};
