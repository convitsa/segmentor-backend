import { PrismaClient } from "@prisma/client";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../.env") });

const prisma = new PrismaClient();

async function main() {
  const MONTHLY_PRICE_ID = process.env.STRIPE_PRICE_ID_MONTHLY;
  const YEARLY_PRICE_ID = process.env.STRIPE_PRICE_ID_YEARLY;

  if (!MONTHLY_PRICE_ID || !YEARLY_PRICE_ID) {
    console.error("Missing STRIPE_PRICE_ID_MONTHLY or STRIPE_PRICE_ID_YEARLY in .env");
    process.exit(1);
  }

  await prisma.plan.upsert({
    where: { slug: "pro" },
    update: {
      name: "Pro",
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
    },
    create: {
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
    },
  });

  console.log("Seed complete: Pro plan upserted.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
