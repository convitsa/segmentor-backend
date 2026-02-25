const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

interface EmailTemplate {
  subject: string;
  html: string;
}

function layout(body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
  <tr><td style="padding:32px 40px 24px;border-bottom:1px solid #e4e4e7;">
    <span style="font-size:20px;font-weight:700;color:#09090b;">Segmentor</span>
  </td></tr>
  <tr><td style="padding:32px 40px 40px;">${body}</td></tr>
  <tr><td style="padding:20px 40px;background:#fafafa;border-top:1px solid #e4e4e7;">
    <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
      &copy; ${new Date().getFullYear()} Segmentor &middot; No-Code Personalization for Solopreneurs
    </p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function btn(text: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;padding:12px 28px;background:#6366f1;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;margin-top:8px;">${text}</a>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#09090b;line-height:1.3;">${text}</h1>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3f3f46;">${text}</p>`;
}

// ─── Transactional ───

export function welcomeEmail(email: string): EmailTemplate {
  return {
    subject: "Welcome to Segmentor!",
    html: layout(`
      ${heading("Welcome to Segmentor!")}
      ${paragraph(`You've signed up with <strong>${email}</strong>. You're now ready to personalize your website for every visitor — no code required.`)}
      ${paragraph("Here's how to get started:")}
      <ol style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:1.8;color:#3f3f46;">
        <li>Create a project and enter your site URL</li>
        <li>Add the Segmentor script to your site</li>
        <li>Use the visual editor to create personalizations</li>
      </ol>
      ${btn("Go to Dashboard", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function passwordChangedEmail(): EmailTemplate {
  return {
    subject: "Your password was changed",
    html: layout(`
      ${heading("Password changed")}
      ${paragraph("Your Segmentor password was just updated. If you made this change, no further action is needed.")}
      ${paragraph("If you did <strong>not</strong> change your password, please secure your account immediately by resetting it or contacting support.")}
    `),
  };
}

export function accountDeletedEmail(): EmailTemplate {
  return {
    subject: "Your Segmentor account has been deleted",
    html: layout(`
      ${heading("Account deleted")}
      ${paragraph("Your Segmentor account and all associated data (projects, personalizations, analytics) have been permanently removed.")}
      ${paragraph("If this was a mistake or you change your mind, you're welcome to sign up again anytime.")}
      ${paragraph("We're sorry to see you go. Thank you for trying Segmentor.")}
    `),
  };
}

export function subscriptionCreatedEmail(
  planName: string,
  interval: string,
  amount: number
): EmailTemplate {
  const formatted = (amount / 100).toFixed(2);
  return {
    subject: "Subscription confirmed — welcome to " + planName,
    html: layout(`
      ${heading("You're subscribed!")}
      ${paragraph(`Your <strong>${planName}</strong> plan (${interval === "year" ? "yearly" : "monthly"}) is now active.`)}
      <table style="margin:0 0 20px;font-size:15px;color:#3f3f46;line-height:1.8;">
        <tr><td style="padding-right:16px;color:#71717a;">Plan:</td><td><strong>${planName}</strong></td></tr>
        <tr><td style="padding-right:16px;color:#71717a;">Billing:</td><td>${interval === "year" ? "Yearly" : "Monthly"}</td></tr>
        <tr><td style="padding-right:16px;color:#71717a;">Amount:</td><td>$${formatted}/${interval === "year" ? "yr" : "mo"}</td></tr>
      </table>
      ${paragraph("You now have full access to all features. Start personalizing!")}
      ${btn("Open Dashboard", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function subscriptionUpdatedEmail(
  planName: string,
  interval: string
): EmailTemplate {
  return {
    subject: "Your subscription has been updated",
    html: layout(`
      ${heading("Subscription updated")}
      ${paragraph(`Your plan has been updated to <strong>${planName}</strong> (${interval === "year" ? "yearly" : "monthly"} billing).`)}
      ${paragraph("The change takes effect immediately. You can manage your subscription anytime from the billing page.")}
      ${btn("Manage Billing", `${CORS_ORIGIN}/dashboard/billing`)}
    `),
  };
}

export function subscriptionCanceledEmail(): EmailTemplate {
  return {
    subject: "Your Segmentor subscription has been canceled",
    html: layout(`
      ${heading("Subscription canceled")}
      ${paragraph("Your subscription has been canceled. You'll still have access to all features until the end of your current billing period.")}
      ${paragraph("If you change your mind, you can resubscribe anytime from the billing page.")}
      ${paragraph("We'd love to know what we could do better — feel free to reply to this email with any feedback.")}
      ${btn("Resubscribe", `${CORS_ORIGIN}/billing`)}
    `),
  };
}

export function paymentFailedEmail(): EmailTemplate {
  return {
    subject: "Payment failed — action needed",
    html: layout(`
      ${heading("Payment failed")}
      ${paragraph("We couldn't process your latest payment for Segmentor. This usually happens when a card expires or has insufficient funds.")}
      ${paragraph("Please update your payment method to keep your subscription active. If the payment continues to fail, your access may be interrupted.")}
      ${btn("Update Payment Method", `${CORS_ORIGIN}/dashboard/billing`)}
    `),
  };
}

// ─── Marketing ───

export function onboardingDay1Email(name: string): EmailTemplate {
  const who = name || "there";
  return {
    subject: "Getting started with Segmentor",
    html: layout(`
      ${heading(`Hey ${who}, let's get you set up!`)}
      ${paragraph("Welcome to Segmentor! Here's a quick 3-step guide to launch your first personalization:")}
      <ol style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:2;color:#3f3f46;">
        <li><strong>Create a project</strong> — add your website URL</li>
        <li><strong>Install the script</strong> — paste one line into your site</li>
        <li><strong>Open the visual editor</strong> — click any element to personalize it</li>
      </ol>
      ${paragraph("It takes less than 5 minutes. No code required.")}
      ${btn("Start Now", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function onboardingDay3Email(name: string): EmailTemplate {
  const who = name || "there";
  return {
    subject: "3 features you should try in Segmentor",
    html: layout(`
      ${heading(`Hey ${who}, here are some power features`)}
      ${paragraph("Now that you've had a few days with Segmentor, here are features that our top users love:")}
      <ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:2;color:#3f3f46;">
        <li><strong>Geo personalization</strong> — show different content by country or city</li>
        <li><strong>UTM targeting</strong> — customize pages for specific campaigns</li>
        <li><strong>A/B split testing</strong> — test multiple variants with traffic splitting</li>
      </ul>
      ${paragraph("All of these work with the same visual editor — just set your targeting rules.")}
      ${btn("Try It Out", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function onboardingDay7Email(name: string): EmailTemplate {
  const who = name || "there";
  return {
    subject: "How's it going with Segmentor?",
    html: layout(`
      ${heading(`Hey ${who}, checking in!`)}
      ${paragraph("It's been a week since you joined Segmentor. How's it going?")}
      ${paragraph("If you've run into any issues or have questions, just reply to this email — we read and respond to every message.")}
      ${paragraph("If you haven't set up your first personalization yet, now's a great time! It only takes a few minutes.")}
      ${btn("Open Dashboard", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function inactiveReminderEmail(name: string): EmailTemplate {
  const who = name || "there";
  return {
    subject: "We miss you at Segmentor!",
    html: layout(`
      ${heading(`Hey ${who}, we noticed you've been away`)}
      ${paragraph("It's been a while since you last visited Segmentor. Your account is still active and ready to go.")}
      ${paragraph("Website personalization can boost your conversions by 20-30%. Here are some ideas to get started:")}
      <ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:2;color:#3f3f46;">
        <li>Show a welcome message based on visitor location</li>
        <li>Personalize your CTA for different traffic sources</li>
        <li>Hide or show sections based on device type</li>
      </ul>
      ${btn("Come Back", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function trialEndingEmail(
  name: string,
  daysLeft: number
): EmailTemplate {
  const who = name || "there";
  return {
    subject: `Your subscription ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
    html: layout(`
      ${heading(`Hey ${who}, your subscription is ending soon`)}
      ${paragraph(`Your Segmentor subscription will end in <strong>${daysLeft} day${daysLeft === 1 ? "" : "s"}</strong>. After that, your personalizations will stop showing to visitors.`)}
      ${paragraph("To keep your site personalized and your analytics running, make sure to renew your subscription.")}
      ${btn("Renew Now", `${CORS_ORIGIN}/dashboard/billing`)}
    `),
  };
}

export function featureAnnouncementEmail(
  name: string,
  title: string,
  body: string
): EmailTemplate {
  const who = name || "there";
  return {
    subject: title,
    html: layout(`
      ${heading(`Hey ${who}, exciting news!`)}
      ${paragraph(body)}
      ${btn("Check It Out", `${CORS_ORIGIN}/dashboard/projects`)}
    `),
  };
}

export function reviewRequestEmail(name: string): EmailTemplate {
  const who = name || "there";
  return {
    subject: "How are you liking Segmentor?",
    html: layout(`
      ${heading(`Hey ${who}, got a minute?`)}
      ${paragraph("You've been using Segmentor for a while now, and we'd love to hear what you think!")}
      ${paragraph("Your feedback helps us build a better product. What's working well? What could be improved?")}
      ${paragraph("Just <strong>reply to this email</strong> with your thoughts — we read every response.")}
      ${paragraph("Thank you for being a Segmentor user!")}
    `),
  };
}

export function winBackEmail(name: string): EmailTemplate {
  const who = name || "there";
  return {
    subject: "We'd love to have you back",
    html: layout(`
      ${heading(`Hey ${who}, we'd love to have you back!`)}
      ${paragraph("We noticed you canceled your Segmentor subscription. We're sorry to see you go, and we've been working hard to make things better.")}
      ${paragraph("Since you left, we've added:")}
      <ul style="margin:0 0 20px;padding-left:20px;font-size:15px;line-height:2;color:#3f3f46;">
        <li>Improved visual editor performance</li>
        <li>Better analytics dashboard</li>
        <li>More targeting options</li>
      </ul>
      ${paragraph("Come back and give us another try — your projects are waiting for you.")}
      ${btn("Resubscribe", `${CORS_ORIGIN}/billing`)}
    `),
  };
}
