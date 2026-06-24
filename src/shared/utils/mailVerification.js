const nodemailer = require("nodemailer");


const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.support_mail,
    pass: process.env.support_pass,
  },
});

function sendVerificationEmail(
  { email, name, verificationToken, orgId },
  redirectUrl
) {
  const link = `${process.env.STUDENT_VERIFY_URL}/verify?token=${verificationToken}&orgId=${orgId}`;

  const html = `
    <!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Verify Your Email – Skill Medha</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        background-color: #f4f6f8;
        margin: 0;
        padding: 0;
        color: #333;
      }
      .container {
        max-width: 600px;
        margin: 40px auto;
        background-color: #ffffff;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
        overflow: hidden;
      }
      .header {
        background-color: #00796b;
        color: #ffffff;
        padding: 20px;
        text-align: center;
      }
      .header h1 {
        margin: 0;
        font-size: 24px;
      }
      .content {
        padding: 30px;
      }
      .content h2 {
        color: #333333;
        font-size: 20px;
      }
      .verify-button {
        display: inline-block;
        margin-top: 20px;
        padding: 12px 24px;
        background-color: #009688;
        color: #ffffff;
        text-decoration: none;
        border-radius: 6px;
        font-weight: bold;
      }
      .footer {
        margin-top: 40px;
        font-size: 12px;
        color: #888;
        text-align: center;
        padding: 20px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>Welcome to Skill Medha LMS</h1>
      </div>
      <div class="content">
        <h2>Hello ${name},</h2>
        <p>
          Thank you for registering on the Skill Medha Learning Management System.
          To complete your registration, please verify your email address by
          clicking the button below:
        </p>
        <a href="${link}" class="verify-button" style="color:#fff">Verify Email</a>
        <p style="margin-top: 20px;">
          If the button doesn't work, you can also copy and paste the following
          link into your browser:
        </p>
        <p style="word-break: break-all;">${link}</p>
        <p>Thank you,<br />Skill Medha Team</p>
      </div>
      <div class="footer">
        © 2025 Skill Medha. All rights reserved.<br />
        Need help? Contact us at support@skillmedha.com
      </div>
    </div>
  </body>
</html>

  `;

  var mailOptions = {
    from: process.env.support_mail,
    to: email,
    subject: "Account Creation",
    html: html,
  };
  return transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      console.log({
        status: true,
        respMesg: error,
      });
    } else {
      console.log({
        status: true,
        respMesg: "Email Sent Successfully",
      });
    }
  });
}


module.exports = {
  sendVerificationEmail,
}



// Place at the top of your file

const bulkTransporter = nodemailer.createTransport({
    pool: true,
    service: "gmail",
    auth: {
        user: process.env.support_mail,
        pass: process.env.support_pass,
    },
    maxConnections: 5,
    maxMessages: 50,
    rateLimit: 3      // Max 3 emails/second, tweak as needed
});


// Generic batch send, chunked & throttled
async function sendBulkEmails(mailOptionsArray, transporter, batchSize = 15, waitMs = 2000) {
    // mailOptionsArray: array of nodemailer mailOptions
    const successes = [];
    const failures = [];
    for (let i = 0; i < mailOptionsArray.length; i += batchSize) {
        const batch = mailOptionsArray.slice(i, i + batchSize);
        // Send all in current batch in parallel
        const results = await Promise.allSettled(batch.map(opt => transporter.sendMail(opt)));
        // Log results
        results.forEach((res, idx) => {
            if (res.status === "fulfilled") {
                successes.push({...batch[idx], info: res.value});
            } else {
                failures.push({...batch[idx], error: res.reason});
            }
        });
        // Throttle between batches
        if (i + batchSize < mailOptionsArray.length) {
            await new Promise(res => setTimeout(res, waitMs));
        }
    }
    return {successes, failures};
}
