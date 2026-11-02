/**
 * OPS VAGUE 4a — ce que la vague EMPRUNTE à l'ERP, nommé une seule fois. Les modules utilisés par
 * plusieurs morceaux passent par ici : la frontière Adam ↔ ERP (`src/platform/boundary.test.ts`)
 * compte un franchissement par import, et le découpage ne doit pas en ajouter.
 */
export { prisma } from "@/lib/prisma";
