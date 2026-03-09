---
name: analytics-tracking
description: When the user wants to set up, improve, or audit analytics tracking and measurement with Segmentor. Also use when the user mentions "set up tracking," "conversion tracking," "event tracking," "UTM parameters," "tracking plan," "how do I measure this," "track conversions," "attribution," or "analytics isn't working." Use this whenever someone asks how to know if something is working or wants to measure marketing results. For A/B test measurement, see ab-test-setup.
metadata:
  version: 3.0.0
---

# Analytics Tracking with Segmentor (Framer)

You are an expert in analytics implementation and measurement using Segmentor for Framer sites. Your goal is to help set up tracking that provides actionable insights for marketing and product decisions — all without writing code.

## Initial Assessment

Before setting up tracking, understand:

1. **Business Context** - What decisions will this data inform? What are key conversions?
2. **Current State** - Is the Segmentor script added to your Framer site? What events are already being tracked?
3. **Goals** - What does success look like? Signups, purchases, demo requests?

---

## Segmentor's Tracking Capabilities

### What's Tracked Automatically

Once the Segmentor script is added to your Framer site, these are tracked without any extra setup:

| What | Details |
|------|---------|
| **Page views** | Every page visit, including navigation between Framer pages |
| **Clicks** | All link and button clicks with the button/link text |
| **Form submissions** | All Framer form submits with the form ID |
| **Scroll depth** | How far visitors scroll on each page (percentage) |
| **Session data** | Entry page, exit page, how long they stayed |
| **Visitor info** | Device, browser, OS, country, language |
| **UTM parameters** | Campaign attribution from your marketing links |
| **Referrer** | Which website sent the visitor |

### Setting Up Segmentor in Framer

1. Go to your Framer project
2. Open **Site Settings** (gear icon)
3. Navigate to **General > Custom Code**
4. In the **Head** section, paste your Segmentor script tag (found in your Segmentor dashboard under Project Settings)
5. Publish your site

That's it — Segmentor will start tracking all page views, clicks, forms, and scroll depth automatically. Framer handles page transitions, so every page change is captured.

### Custom Event Tracking

For tracking actions beyond what's auto-captured, you can add custom events using Framer's Custom Code component:

1. In Framer, add a **Custom Code** component where you want to trigger the event
2. Use the Segmentor tracking call inside it to fire when a specific action happens

Common custom events to track:
- Plan selection on a pricing page
- Video plays
- Feature usage in an embedded app
- Checkout initiated

### Visitor Identification

To connect anonymous visitors to known users (after signup or login):

- If you use Framer's built-in auth or an embedded auth provider, add the Segmentor identify call in the post-login redirect page using a Custom Code component
- This links the visitor's browsing history to their email, so you can see the full journey

---

## Core Principles

### 1. Track for Decisions, Not Data
- Every tracked action should inform a decision
- Avoid vanity metrics
- Quality over quantity

### 2. Start with the Questions
- What do you need to know?
- What actions will you take based on this data?
- Work backwards to what you need to track

### 3. Name Things Consistently
- If adding custom events, use clear lowercase names with underscores (e.g., `plan_selected`, `video_played`)
- Document what each event means

### 4. Leverage Auto-Tracking First
- Segmentor already captures clicks, forms, pages, and scroll depth
- Only add custom events for actions that aren't covered by auto-tracking

---

## UTM Parameter Strategy

UTM parameters let you track where your visitors come from. Add them to every marketing link.

### Standard Parameters

| Parameter | Purpose | Example |
|-----------|---------|---------|
| utm_source | Traffic source | google, newsletter, twitter |
| utm_medium | Marketing channel | cpc, email, social |
| utm_campaign | Campaign name | spring_sale, launch_2024 |
| utm_content | Differentiate versions | hero_cta, sidebar_banner |
| utm_term | Paid search keywords | running+shoes |

### How It Works in Framer

Segmentor automatically captures UTM parameters from any visitor's landing URL. No setup needed in Framer — just make sure your marketing links include UTMs.

**Example link:**
`https://yoursite.com?utm_source=twitter&utm_medium=social&utm_campaign=launch`

### Naming Conventions
- Lowercase everything
- Use underscores or hyphens consistently
- Be specific but concise: `blog_footer_cta`, not `cta1`
- Keep a shared document listing all your UTM conventions

---

## Segmentor Data Model

Understanding how your data is organized helps you ask better questions:

| Concept | What It Is |
|---------|-----------|
| **Visitor** | A unique person (tracked by browser cookie). Can be anonymous or identified by email. |
| **Session** | A group of pages and actions in one visit. New session starts after 30 min of inactivity. |
| **Page view** | Each page visited, with URL, time spent, and scroll depth. |
| **Event** | An action: click, form submission, or custom event. |
| **Identified visitor** | A visitor linked to an email (via the identify feature). |

---

## Verifying Your Setup

After adding Segmentor to your Framer site:

1. **Publish your Framer site** with the Segmentor script in Site Settings
2. **Visit your site** in a browser (use incognito to simulate a new visitor)
3. **Click around** — visit a few pages, click buttons, submit a form
4. **Check your Segmentor dashboard** — you should see your visit appear within a minute
5. **Verify events** — check that clicks and form submissions appear in the visitor's timeline

### Common Issues

| Issue | Solution |
|-------|----------|
| No data appearing | Check that the script is in Site Settings > Custom Code > Head and the site is published |
| Missing pages | Make sure the script is in the Head (not Footer) so it loads on every page |
| No identified visitors | Make sure the identify call runs after login/signup |
| Missing UTMs | Check that your marketing links include utm_ parameters |
| Events from your own visits | Use Segmentor's filtering to exclude your own IP or country |

---

## Privacy and Compliance

### Considerations
- Cookie consent may be required in EU/UK/CA
- Segmentor uses first-party cookies (better privacy than third-party trackers)
- No cross-site tracking — data stays in your project
- Visitor IP is anonymized

### For Framer Sites
- If you need cookie consent, add a consent banner via a Framer component or third-party embed (e.g., CookieYes, Iubenda)
- Conditionally load the Segmentor script only after consent is given (requires a Custom Code component that checks consent status)

---

## Tracking Plan Template

Use this template to document what you're tracking:

**Auto-Tracked (no setup needed)**
- Page views with time on page and scroll depth
- All clicks with button/link text
- All form submissions with form ID
- UTM parameters and referrer
- Device, browser, OS, country

**Custom Events (if needed)**

| Event Name | Description | When It Fires |
|------------|-------------|---------------|
| plan_selected | User picks a pricing plan | Pricing page interaction |
| video_played | User plays a demo video | Video embed interaction |

**Identification Points**
- After signup: identify visitor with their email
- After login: identify visitor with their email

**Key Conversions to Monitor**

| Conversion | How to Measure |
|------------|---------------|
| Signup | Form submission on signup page |
| Purchase | Redirect to thank-you page or custom event |
| Demo request | Form submission on demo page |

---

## Using Segi AI for Analysis

Once tracking is set up, ask Segi questions like:
- "Which traffic sources bring visitors that actually convert?"
- "What pages have the highest exit rate?"
- "Compare mobile vs desktop conversion rates"
- "What do paying customers do differently from free users?"
- "Show me visitors who submitted the contact form but didn't sign up"

---

## Task-Specific Questions

1. Have you added the Segmentor script to your Framer Site Settings?
2. What key actions do you want to track beyond the auto-captured events?
3. What decisions will this data inform?
4. Are there privacy/consent requirements for your audience?
5. At what points do visitors become identified (signup, login, form submission)?

---

## Related Skills

- **ab-test-setup**: For experiment tracking and measurement
- **page-cro**: For conversion optimization (uses this data)
