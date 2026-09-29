// One-tap text messages. They open the phone's Messages app with the words filled in;
// nothing is sent until the owner taps Send, and no paid service is involved.
import { whenText } from './format.js';

export const smsLink = (phone, body) => `sms:+1${String(phone).replace(/\D/g, '').slice(-10)}?&body=${encodeURIComponent(body)}`;
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

export const followUpText = (j, biz) =>
  `Hi ${first(j.client_name)}, it's ${biz} checking in on the quote I sent for ${j.job_type}. Any questions, or would you like to go ahead? Happy to help.`;

export const reminderText = (j, biz) =>
  `Hi ${first(j.client_name)}, this is ${biz} confirming ${j.status_key === 'visit' ? 'our visit' : 'your appointment'} ${whenText(j)}. Reply here if anything changes.`;

export const onMyWayText = (j, biz) =>
  `Hi ${first(j.client_name)}, it's ${biz}. I'm on my way now.`;

/** Days since the quote went out, or null if it has not been sent. */
export const quietDays = (j, now = Date.now()) =>
  j.status_key === 'quoted' && j.quote?.sent_at && !j.quote_accepted_at
    ? Math.floor((now - new Date(j.quote.sent_at).getTime()) / 86400000) : null;
