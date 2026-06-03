const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.ALERT_EMAIL_USER,
    pass: process.env.ALERT_EMAIL_PASS,
  },
});

async function sendEmail(to, subject, html) {
  await transporter.sendMail({
    from: `"FoodUp Monitor" <${process.env.ALERT_EMAIL_USER}>`,
    to,
    subject,
    html,
  });
  console.log('[alertService] email sent to:', to, '|', subject);
}

function createAlertService(redisCommand, k) {
  async function getAlertSettings() {
    const data = await redisCommand('GET', 'alert_settings');
    return data.result ? JSON.parse(data.result) : { alert_email: '', offline_threshold_minutes: 30 };
  }

  async function handleWebsiteAlert(code, healthResult, restaurantName) {
    try {
      const settings = await getAlertSettings();
      if (!settings.alert_email) {
        console.log(`[alertService] website ${code}: no alert_email configured, skipping`);
        return;
      }

      const alertKey = k(code, 'alert_sent_website');
      const alertSentData = await redisCommand('GET', alertKey);
      console.log(`[alertService] website ${code}: status=${healthResult.status} alertKey=${alertSentData.result || 'not set'}`);

      if (healthResult.status === 'down') {
        if (!alertSentData.result) {
          try {
            await sendEmail(
              settings.alert_email,
              `FoodUp Alert - ${restaurantName} website is down`,
              `<div style="font-family:Arial,sans-serif;padding:20px;">
                <h2 style="color:#e74c3c;">FoodUp Monitor Alert</h2>
                <p>Restaurant <strong>${restaurantName}</strong> (${code}) website is <strong>DOWN</strong>.</p>
                <p>Error: ${healthResult.error || 'Unknown'}</p>
                <p>Checked at: ${new Date(healthResult.checked_at).toLocaleString('de-CH')}</p>
                <br>
                <a href="https://foodup-order-alerts-backend.onrender.com/dashboard"
                  style="background:#8B38CB;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">
                  Open Dashboard
                </a>
                <p style="color:#999;font-size:12px;margin-top:16px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
              </div>`
            );
            // Only mark as sent if email actually succeeded
            await redisCommand('SET', alertKey, 'down');
            await redisCommand('EXPIRE', alertKey, 3600);
            console.log(`[alertService] website ${code}: alert key set to 'down'`);
          } catch (emailErr) {
            console.log(`[alertService] website ${code}: email failed (${emailErr.message}) — key NOT set, will retry next check`);
          }
        } else {
          console.log(`[alertService] website ${code}: alert already sent, skipping`);
        }
      } else {
        if (alertSentData.result === 'down') {
          try {
            await sendEmail(
              settings.alert_email,
              `FoodUp Alert - ${restaurantName} website is back online`,
              `<div style="font-family:Arial,sans-serif;padding:20px;">
                <h2 style="color:#2ecc71;">FoodUp Monitor - Recovered</h2>
                <p>Restaurant <strong>${restaurantName}</strong> (${code}) website is back <strong>online</strong>.</p>
                <p>Response time: ${healthResult.response_ms}ms</p>
                <p>Checked at: ${new Date(healthResult.checked_at).toLocaleString('de-CH')}</p>
                <p style="color:#999;font-size:12px;margin-top:16px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
              </div>`
            );
          } catch (emailErr) {
            console.log(`[alertService] website ${code}: recovery email failed (${emailErr.message})`);
          } finally {
            // Always clear the key on recovery regardless of email success
            await redisCommand('DEL', alertKey);
            console.log(`[alertService] website ${code}: alert key cleared on recovery`);
          }
        }
      }
    } catch (e) {
      console.log('[alertService] handleWebsiteAlert error:', e.message);
    }
  }

  async function handleAppOfflineAlert(code, minutesOffline, heartbeat, restaurantName) {
    try {
      const settings = await getAlertSettings();
      if (!settings.alert_email) {
        console.log(`[alertService] app ${code}: no alert_email configured, skipping`);
        return;
      }
      if (minutesOffline < settings.offline_threshold_minutes) {
        console.log(`[alertService] app ${code}: ${minutesOffline}m offline, threshold=${settings.offline_threshold_minutes}m, not yet`);
        return;
      }

      const alertKey = k(code, 'alert_sent');
      const alertSentData = await redisCommand('GET', alertKey);
      console.log(`[alertService] app ${code}: ${minutesOffline}m offline, alertKey=${alertSentData.result || 'not set'}`);

      if (alertSentData.result) {
        console.log(`[alertService] app ${code}: alert already sent, skipping`);
        return;
      }

      const hoursOffline = minutesOffline >= 60
        ? `${Math.floor(minutesOffline / 60)}h ${minutesOffline % 60}m`
        : `${minutesOffline} minutes`;

      try {
        await sendEmail(
          settings.alert_email,
          `FoodUp Alert - ${restaurantName} is offline`,
          `<div style="font-family:Arial,sans-serif;padding:20px;">
            <h2 style="color:#e74c3c;">FoodUp Monitor Alert</h2>
            <p>Restaurant <strong>${restaurantName}</strong> (${code}) has been offline for <strong>${hoursOffline}</strong>.</p>
            <p>Last seen: ${new Date(heartbeat.last_seen).toLocaleString('de-CH')}</p>
            <p>Please check if the app is open and the device is connected to the internet.</p>
            <br>
            <a href="https://foodup-order-alerts-backend.onrender.com/dashboard"
              style="background:#8B38CB;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">
              Open Dashboard
            </a>
            <p style="color:#999;font-size:12px;margin-top:16px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
          </div>`
        );
        // Only mark as sent if email actually succeeded
        await redisCommand('SET', alertKey, 'offline');
        await redisCommand('EXPIRE', alertKey, 3600);
        console.log(`[alertService] app ${code}: alert key set to 'offline'`);
      } catch (emailErr) {
        console.log(`[alertService] app ${code}: email failed (${emailErr.message}) — key NOT set, will retry next check`);
      }
    } catch (e) {
      console.log('[alertService] handleAppOfflineAlert error:', e.message);
    }
  }

  async function handleAppRecoveredAlert(code, restaurantName, lastSeen) {
    try {
      const settings = await getAlertSettings();
      if (!settings.alert_email) return;
      const alertKey = k(code, 'alert_sent');
      const alertSentData = await redisCommand('GET', alertKey);
      console.log(`[alertService] app ${code}: recovery check, alertKey=${alertSentData.result || 'not set'}`);
      if (alertSentData.result !== 'offline') return;

      try {
        await sendEmail(
          settings.alert_email,
          `FoodUp Alert - ${restaurantName} is back online`,
          `<div style="font-family:Arial,sans-serif;padding:20px;">
            <h2 style="color:#2ecc71;">FoodUp Monitor - Recovered</h2>
            <p>Restaurant <strong>${restaurantName}</strong> (${code}) is back online.</p>
            <p>Last seen: ${new Date(lastSeen).toLocaleString('de-CH')}</p>
            <p style="color:#999;font-size:12px;margin-top:16px;">Sent at ${new Date().toLocaleString('de-CH')}</p>
          </div>`
        );
      } catch (emailErr) {
        console.log(`[alertService] app ${code}: recovery email failed (${emailErr.message})`);
      } finally {
        // Always clear the key on recovery regardless of email success
        await redisCommand('DEL', alertKey);
        console.log(`[alertService] app ${code}: alert key cleared on recovery`);
      }
    } catch (e) {
      console.log('[alertService] handleAppRecoveredAlert error:', e.message);
    }
  }

  return { handleWebsiteAlert, handleAppOfflineAlert, handleAppRecoveredAlert };
}

module.exports = { createAlertService };
