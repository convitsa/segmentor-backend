import { config } from "dotenv";
import { resolve } from "path";
import mongoose from "mongoose";
import { Plan } from "../src/db/models.js";

config({ path: resolve(__dirname, "../.env") });

async function main() {
  const MONTHLY_PRICE_ID = process.env.STRIPE_PRICE_ID_MONTHLY;
  const YEARLY_PRICE_ID = process.env.STRIPE_PRICE_ID_YEARLY;
  const DATABASE_URL = process.env.DATABASE_URL;

  if (!MONTHLY_PRICE_ID || !YEARLY_PRICE_ID) {
    console.error("Missing STRIPE_PRICE_ID_MONTHLY or STRIPE_PRICE_ID_YEARLY in .env");
    process.exit(1);
  }
  if (!DATABASE_URL) {
    console.error("Missing DATABASE_URL in .env");
    process.exit(1);
  }

  await mongoose.connect(DATABASE_URL);

  const data = {
    name: "Pro",
    slug: "pro",
    monthlyPrice: 900,
    yearlyPrice: 8900,
    stripePriceIdMonthly: MONTHLY_PRICE_ID,
    stripePriceIdYearly: YEARLY_PRICE_ID,
    features: [
      "Unlimited projects",
      "Unlimited personalizations",
      "Visual editor",
      "Audience targeting",
      "Analytics dashboard",
      "Geo & time conditions",
      "Priority support",
    ],
    active: true,
  };

  await Plan.findOneAndUpdate({ slug: "pro" }, { $set: data }, { upsert: true, new: true });

  console.log("Seed complete: Pro plan upserted.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => mongoose.disconnect());
