/**
 * UN CHANTIER FACTICE POUR L'ÉCRAN (lot C1, décision 0042) — sème, sur la base de BANC, deux chantiers du Super Admin conduits
 * par les PORTS FACTICES (aucun réseau) : l'un LIVRÉ (vert, déployé, sain), l'autre arrêté sur la carte de validation d'un
 * déploiement de production. Sert au contrôle du tableau « Missions » sur serveur réel (Playwright, iPhone 13 + bureau).
 *
 *   npm run bench:live -- scripts/bench/chantier-factice-ui.ts
 */
import { prisma } from "@/lib/prisma";
import { approuverChantier, proposerChantier } from "@/lib/missions/chantiers/service";
import { conduireChantier } from "@/lib/missions/chantiers/conduite";
import { REGLAGES_CHANTIERS_DEFAUT } from "@/lib/missions/chantiers/regles";
import { fauxPortsDev, type ScenarioDev } from "@/lib/missions/chantiers/faux-test-outils";
import type { LecteurInterrupteur } from "@/lib/interrupteurs/missions";

const PAS_SUSPENDU: LecteurInterrupteur = async () => ({ suspendues: false, depuis: null, parId: null } as Awaited<ReturnType<LecteurInterrupteur>>);
const CERVEAU = { disponibles: () => ({ mimo: false, terra: false, sol: false }), executer: async () => ({ ok: false as const, erreur: "aucun modèle" }) };

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "") || !/bench/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base de banc locale seulement.");
  const sa = await prisma.user.findUniqueOrThrow({ where: { email: "super@adventum-bench.dz" }, select: { id: true } });
  const semer = async (titre: string, branche: string, production: boolean, surSession: ScenarioDev["surSession"]) => {
    const p = await proposerChantier(sa.id, {
      titre, objectif: "Ajouter la route /api/sante qui rend 200 et son test.", depot: { proprietaire: "aminedjm", nom: "amd-internal-os" }, branche,
      perimetre: [`src/app/api/${branche.split("/")[1]}/**`, "src/lib/missions/chantiers/**"], criteres: ["GET rend 200", "npm test vert"], commandesVerif: ["npm test"],
      services: [{ id: `srv-bench-${branche.split("/")[1]}`, nom: production ? "ERP (production)" : "ERP préproduction", role: "erp", production, url: "https://erp.test", healthCheckPath: "/api/health" }],
    });
    if (!p.ok) throw new Error(p.fautes.join(" "));
    await approuverChantier(p.chantierId, sa.id);
    const ports = fauxPortsDev({ surSession });
    const h = { t: Date.now(), now() { return new Date(this.t); } };
    for (let i = 0; i < 8; i++) {
      await conduireChantier(p.chantierId, { ports, cerveau: CERVEAU, clock: h, reglages: REGLAGES_CHANTIERS_DEFAUT, interrupteur: PAS_SUSPENDU });
      h.t += 31 * 60_000;
    }
    const m = await prisma.mission.findUniqueOrThrow({ where: { id: p.chantierId }, select: { status: true } });
    console.log(`${titre} → ${m.status} (${p.chantierId})`);
  };
  await semer("Route de santé — préproduction", "claude/sante-preprod", false, (n) => (n === 1 ? { sha: "a1b2c3d4e5f60001", checks: "rouge", extrait: "FAIL src/app/api/sante/route.test.ts > attendu 200, reçu 404" } : { sha: "a1b2c3d4e5f60002", checks: "vert" }));
  await semer("Route de santé — production", "claude/sante-prod", true, () => ({ sha: "f0e1d2c3b4a50001", checks: "vert" }));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
