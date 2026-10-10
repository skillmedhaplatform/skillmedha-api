const generateVerificationHtml = (name, link, portalUrl) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f5f7; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { background: linear-gradient(135deg, #1b539c, #2a73c9); padding: 40px; color: #ffffff; }
    .header-top { display: flex; align-items: center; margin-bottom: 30px; }
    .logo { width: 40px; height: 40px; margin-right: 15px; display: block; }
    .brand-title { margin: 0; font-size: 20px; font-weight: 700; }
    .brand-subtitle { margin: 0; font-size: 12px; color: #b8d2ef; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .header-main { display: flex; align-items: center; }
    .shield-icon { width: 36px; height: 36px; margin-right: 15px; background: rgba(255,255,255,0.15); padding: 10px; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
    .header-h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 0.5px; }
    .header-p { margin: 5px 0 0; font-size: 11px; font-weight: 600; text-transform: uppercase; color: #b8d2ef; letter-spacing: 1px; }
    
    .body-content { padding: 40px; color: #333333; }
    .greeting { font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 15px; color: #1a1a1a; }
    .greeting span { color: #2a73c9; }
    .welcome-text { font-size: 15px; line-height: 1.6; color: #4a5568; margin-bottom: 35px; }
    
    .steps { display: table; width: 100%; margin-bottom: 40px; text-align: center; }
    .step { display: table-cell; position: relative; width: 33.33%; font-size: 12px; font-weight: 600; color: #a0aec0; }
    .step-active { color: #2a73c9; }
    .step-circle { width: 28px; height: 28px; border-radius: 50%; background-color: #edf2f7; color: #a0aec0; line-height: 28px; margin: 0 auto 10px; font-weight: 700; font-size: 14px; position: relative; z-index: 2; }
    .step-active .step-circle { background-color: #2a73c9; color: #ffffff; }
    .step-line { position: absolute; top: 14px; left: 50%; width: 100%; height: 2px; background-color: #edf2f7; z-index: 1; }
    
    .btn-container { text-align: center; margin-bottom: 10px; }
    .btn { display: inline-block; background-color: #1e5aa8; color: #ffffff !important; text-decoration: none; padding: 14px 30px; border-radius: 6px; font-weight: 700; font-size: 16px; box-shadow: 0 4px 6px rgba(30, 90, 168, 0.2); }
    .btn-subtext { text-align: center; font-size: 12px; color: #a0aec0; margin-bottom: 40px; }
    
    .alert-box { background-color: #f0f7ff; border: 1px solid #d4e5ff; border-radius: 8px; padding: 20px; margin-bottom: 35px; display: flex; align-items: flex-start; }
    .alert-icon { font-size: 20px; margin-right: 15px; }
    .alert-title { margin: 0 0 5px; font-size: 14px; font-weight: 700; color: #1e5aa8; }
    .alert-text { margin: 0; font-size: 13px; color: #4a5568; line-height: 1.5; }
    
    .link-fallback { margin-bottom: 40px; }
    .link-fallback-p { font-size: 14px; color: #4a5568; margin-bottom: 12px; }
    .link-box { background-color: #f7fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 6px; font-size: 12px; color: #2a73c9; word-break: break-all; }
    
    .team-section { display: flex; align-items: center; }
    .team-icon { width: 40px; height: 40px; background-color: #1e5aa8; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; margin-right: 15px; }
    .team-details { display: flex; flex-direction: column; justify-content: center; }
    .team-name { margin: 0 0 4px; font-weight: 700; font-size: 15px; color: #1a1a1a; }
    .team-slogan { margin: 0; font-size: 12px; color: #718096; }
    
    .footer { background-color: #f8fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
    .help-text { margin: 0 0 20px; font-size: 13px; color: #4a5568; font-weight: 600; }
    .help-link { color: #2a73c9; text-decoration: none; }
    .footer-links { margin-bottom: 25px; }
    .footer-links a { color: #718096; text-decoration: none; font-size: 12px; margin: 0 10px; }
    .footer-logo { font-size: 14px; font-weight: 700; color: #4a5568; margin-bottom: 15px; display: flex; align-items: center; justify-content: center; }
    .footer-logo img { width: 16px; height: 16px; margin-right: 8px; }
    .copyright { margin: 0 0 5px; font-size: 11px; color: #a0aec0; }
    .unsubscribe { margin: 0; font-size: 11px; color: #a0aec0; }
  </style>
</head>
<body>
  <div style="background-color: #f4f5f7; padding: 40px 20px;">
    <div class="container">
      <div class="header">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 30px;">
                <tr>
                  <td valign="middle"><img src="cid:logo" alt="Logo" style="width: 40px; height: 40px; margin-right: 15px; display: block;" /></td>
                  <td valign="middle">
                    <h2 class="brand-title">SkillMedha</h2>
                    <p class="brand-subtitle">Learning Management System</p>
                  </td>
                </tr>
              </table>
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <div class="shield-icon" style="width: 36px; height: 36px; margin-right: 15px; background: rgba(255,255,255,0.15); border-radius: 12px; text-align: center; line-height: 36px;">
                      <img src="https://img.icons8.com/ios-filled/50/ffffff/shield.png" width="24" height="24" alt="Shield" style="vertical-align: middle; display: inline-block; margin-top: 6px;" />
                    </div>
                  </td>
                  <td valign="middle">
                    <h1 class="header-h1">Verify Your Email</h1>
                    <p class="header-p">One quick step to activate your account</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
      
      <div class="body-content">
        <h2 class="greeting">Hello <span>${name}</span>,</h2>
        <p class="welcome-text">Welcome to <strong>Skill Medha LMS</strong>! We're excited to have you on board. To activate your account and begin your learning journey, please verify your email address by clicking the button below.</p>
        
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 40px; text-align: center;">
          <tr>
            <td width="33%" style="position: relative;">
              <div class="step-active">
                <div class="step-circle">1</div>
                <div style="font-size: 12px; font-weight: 600;">Verify Email</div>
              </div>
            </td>
            <td width="33%" style="position: relative;">
              <div class="step">
                <div class="step-circle">2</div>
                <div style="font-size: 12px; font-weight: 600;">Complete Profile</div>
              </div>
            </td>
            <td width="33%" style="position: relative;">
              <div class="step">
                <div class="step-circle">3</div>
                <div style="font-size: 12px; font-weight: 600;">Start Learning</div>
              </div>
            </td>
          </tr>
        </table>
        
        <div class="btn-container">
          <a href="${link}" class="btn">✉ Verify Email Address</a>
        </div>
        <p class="btn-subtext">This link expires in 24 hours</p>
        
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 35px;">
          <tr>
            <td style="background-color: #f0f7ff; border: 1px solid #d4e5ff; border-radius: 8px; padding: 20px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="top" style="padding-right: 15px; font-size: 20px;">🔒</td>
                  <td valign="top">
                    <p class="alert-title">This link is unique to your account</p>
                    <p class="alert-text">If you did not create a Skill Medha account, you can safely ignore this email. No action is needed.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        
        <div class="link-fallback">
          <p class="link-fallback-p">If the button above doesn't work, copy and paste the following link into your browser:</p>
          <div class="link-box">${link}</div>
        </div>
        
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="40" valign="middle">
              <div class="team-icon" style="width: 40px; height: 40px; background-color: #1e5aa8; border-radius: 8px; text-align: center;">
                <img src="https://img.icons8.com/ios-filled/50/ffffff/combo-chart.png" width="20" height="20" alt="Chart" style="vertical-align: middle; display: inline-block; margin-top: 10px;" />
              </div>
            </td>
            <td valign="middle" style="padding-left: 15px;">
              <p class="team-name">The Skill Medha Team</p>
              <p class="team-slogan">Empowering learners, one skill at a time.</p>
            </td>
          </tr>
        </table>
      </div>
      
      <div class="footer">
        <p class="help-text">Need help? <a href="mailto:ksquareinfo2@gmail.com" class="help-link">ksquareinfo2@gmail.com</a></p>
        <div class="footer-links">
          <a href="${portalUrl}/privacy">Privacy Policy</a>
          <a href="${portalUrl}/terms">Terms and Conditions</a>
          <a href="${portalUrl}/cookie-policy">Cookie Policy</a>
          <a href="${portalUrl}/refund-policy">Refund Policy</a>
        </div>
        <div class="footer-logo">
          <img src="cid:logo" alt="Logo" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: middle; display: inline-block;" />
          SkillMedha
        </div>
        <p class="copyright">&copy; 2026 Skill Medha. All rights reserved.</p>
        <p class="unsubscribe">You received this email because you registered at skillmedha.com</p>
      </div>
    </div>
  </div>
</body>
</html>`;
};

const generateForgotPasswordHtml = (link, portalUrl) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f5f7; }
    .container { max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); }
    .header { background: linear-gradient(135deg, #1b539c, #2a73c9); padding: 40px; color: #ffffff; }
    .header-top { display: flex; align-items: center; margin-bottom: 30px; }
    .logo { width: 40px; height: 40px; margin-right: 15px; display: block; }
    .brand-title { margin: 0; font-size: 20px; font-weight: 700; }
    .brand-subtitle { margin: 0; font-size: 12px; color: #b8d2ef; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; }
    .header-main { display: flex; align-items: center; }
    .shield-icon { width: 36px; height: 36px; margin-right: 15px; background: rgba(255,255,255,0.15); padding: 10px; border-radius: 12px; display: flex; align-items: center; justify-content: center; }
    .header-h1 { margin: 0; font-size: 24px; font-weight: 800; letter-spacing: 0.5px; }
    .header-p { margin: 5px 0 0; font-size: 11px; font-weight: 600; text-transform: uppercase; color: #b8d2ef; letter-spacing: 1px; }
    
    .body-content { padding: 40px; color: #333333; }
    .greeting { font-size: 20px; font-weight: 700; margin-top: 0; margin-bottom: 15px; color: #1a1a1a; }
    .greeting span { color: #2a73c9; }
    .welcome-text { font-size: 15px; line-height: 1.6; color: #4a5568; margin-bottom: 35px; }
    
    .btn-container { text-align: center; margin-bottom: 10px; margin-top: 20px; }
    .btn { display: inline-block; background-color: #1e5aa8; color: #ffffff !important; text-decoration: none; padding: 14px 30px; border-radius: 6px; font-weight: 700; font-size: 16px; box-shadow: 0 4px 6px rgba(30, 90, 168, 0.2); }
    .btn-subtext { text-align: center; font-size: 12px; color: #a0aec0; margin-bottom: 40px; }
    
    .alert-box { background-color: #fffaf0; border: 1px solid #feebc8; border-radius: 8px; padding: 20px; margin-bottom: 35px; display: flex; align-items: flex-start; }
    .alert-icon { font-size: 20px; margin-right: 15px; }
    .alert-title { margin: 0 0 5px; font-size: 14px; font-weight: 700; color: #dd6b20; }
    .alert-text { margin: 0; font-size: 13px; color: #4a5568; line-height: 1.5; }
    
    .link-fallback { margin-bottom: 40px; }
    .link-fallback-p { font-size: 14px; color: #4a5568; margin-bottom: 12px; }
    .link-box { background-color: #f7fafc; border: 1px solid #e2e8f0; padding: 15px; border-radius: 6px; font-size: 12px; color: #2a73c9; word-break: break-all; }
    
    .team-section { display: flex; align-items: center; }
    .team-icon { width: 40px; height: 40px; background-color: #1e5aa8; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; margin-right: 15px; }
    .team-details { display: flex; flex-direction: column; justify-content: center; }
    .team-name { margin: 0 0 4px; font-weight: 700; font-size: 15px; color: #1a1a1a; }
    .team-slogan { margin: 0; font-size: 12px; color: #718096; }
    
    .footer { background-color: #f8fafc; padding: 30px 40px; text-align: center; border-top: 1px solid #e2e8f0; }
    .help-text { margin: 0 0 20px; font-size: 13px; color: #4a5568; font-weight: 600; }
    .help-link { color: #2a73c9; text-decoration: none; }
    .footer-links { margin-bottom: 25px; }
    .footer-links a { color: #718096; text-decoration: none; font-size: 12px; margin: 0 10px; }
    .footer-logo { font-size: 14px; font-weight: 700; color: #4a5568; margin-bottom: 15px; display: flex; align-items: center; justify-content: center; }
    .footer-logo img { width: 16px; height: 16px; margin-right: 8px; }
    .copyright { margin: 0 0 5px; font-size: 11px; color: #a0aec0; }
    .unsubscribe { margin: 0; font-size: 11px; color: #a0aec0; }
  </style>
</head>
<body>
  <div style="background-color: #f4f5f7; padding: 40px 20px;">
    <div class="container">
      <div class="header">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 30px;">
                <tr>
                  <td valign="middle"><img src="cid:logo" alt="Logo" style="width: 40px; height: 40px; margin-right: 15px; display: block;" /></td>
                  <td valign="middle">
                    <h2 class="brand-title">SkillMedha</h2>
                    <p class="brand-subtitle">Learning Management System</p>
                  </td>
                </tr>
              </table>
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <div class="shield-icon" style="width: 36px; height: 36px; margin-right: 15px; background: rgba(255,255,255,0.15); border-radius: 12px; text-align: center; line-height: 36px;">
                      <img src="https://img.icons8.com/ios-filled/50/ffffff/lock.png" width="24" height="24" alt="Lock" style="vertical-align: middle; display: inline-block; margin-top: 6px;" />
                    </div>
                  </td>
                  <td valign="middle">
                    <h1 class="header-h1">Reset Your Password</h1>
                    <p class="header-p">Securely regain access to your account</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </div>
      
      <div class="body-content">
        <h2 class="greeting">Hello,</h2>
        <p class="welcome-text">We received a request to reset the password for your <strong>Skill Medha LMS</strong> account. You can securely set a new password by clicking the button below.</p>
        
        <div class="btn-container">
          <a href="${link}" class="btn">🔑 Reset Password</a>
        </div>
        <p class="btn-subtext">This link expires in 15 minutes</p>
        
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 35px;">
          <tr>
            <td style="background-color: #fffaf0; border: 1px solid #feebc8; border-radius: 8px; padding: 20px;">
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="top" style="padding-right: 15px; font-size: 20px;">🔒</td>
                  <td valign="top">
                    <p class="alert-title">Didn't request this?</p>
                    <p class="alert-text">If you didn't ask to reset your password, you can safely ignore this email. Your account remains secure.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        
        <div class="link-fallback">
          <p class="link-fallback-p">If the button above doesn't work, copy and paste the following link into your browser:</p>
          <div class="link-box">${link}</div>
        </div>
        
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="40" valign="middle">
              <div class="team-icon" style="width: 40px; height: 40px; background-color: #1e5aa8; border-radius: 8px; text-align: center;">
                <img src="https://img.icons8.com/ios-filled/50/ffffff/combo-chart.png" width="20" height="20" alt="Chart" style="vertical-align: middle; display: inline-block; margin-top: 10px;" />
              </div>
            </td>
            <td valign="middle" style="padding-left: 15px;">
              <p class="team-name">The Skill Medha Team</p>
              <p class="team-slogan">Empowering learners, one skill at a time.</p>
            </td>
          </tr>
        </table>
      </div>
      
      <div class="footer">
        <p class="help-text">Need help? <a href="mailto:ksquareinfo2@gmail.com" class="help-link">ksquareinfo2@gmail.com</a></p>
        <div class="footer-links">
          <a href="${portalUrl}/privacy">Privacy Policy</a>
          <a href="${portalUrl}/terms">Terms and Conditions</a>
          <a href="${portalUrl}/cookie-policy">Cookie Policy</a>
          <a href="${portalUrl}/refund-policy">Refund Policy</a>
        </div>
        <div class="footer-logo">
          <img src="cid:logo" alt="Logo" style="width: 16px; height: 16px; margin-right: 8px; vertical-align: middle; display: inline-block;" />
          SkillMedha
        </div>
        <p class="copyright">&copy; 2026 Skill Medha. All rights reserved.</p>
        <p class="unsubscribe">You received this email because you registered at skillmedha.com</p>
      </div>
    </div>
  </div>
</body>
</html>`;
};

module.exports = { generateVerificationHtml, generateForgotPasswordHtml };
