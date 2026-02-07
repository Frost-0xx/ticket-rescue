const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const res = await prisma.offer.updateMany({
    where: { source: { equals: "geturtix", mode: "insensitive" } },
    data: { promoCode: "GTIX20", promoPercent: 20 }
  });

  console.log("Updated offers:", res);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });