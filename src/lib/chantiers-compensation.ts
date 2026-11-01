import { prisma } from "@/lib/prisma";
import type { PolitiqueAnnulation, ResultatMetier } from "@/lib/effets/politiques";
import type { DetailEffet } from "@/lib/effets/annulation";
import { lireDossier } from "@/lib/missions/chantiers/dossier";
import { ecrireDossier } from "@/lib/missions/chantiers/conduite";
import { demanderRevertFusion } from "@/lib/missions/chantiers/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * ANNULER LA VALIDATION D'UN CHANTIER (C1, décision 0042 ; K10c, décision 0044) — le geste inverse MÉTIER de
 * `assistant-ia-travaux-actions:validerMonChantier`, appelé par l'annulation J7 (`effets/politiques.ts`).
 *
 * Effacer ligne à ligne serait faux : le dossier a bougé depuis (le moteur y écrit à chaque étape). Donc :
 *   • le geste n'a PAS encore agi → la validation est RETIRÉE et l'étape attend de nouveau la Direction (ANNULÉ) ;
 *   • la FUSION a eu lieu → COMPENSÉE : une PR de revert est ouverte et proposée (jamais un force-push), sa fusion
 *     repasse par la validation ;
 *   • un déploiement ou un rollback de PRODUCTION a eu lieu → IMPOSSIBLE ici, dit avec le geste qui reste (rollback,
 *     nouveau chantier) — un « tout ou rien » refuse alors l'annulation entière, la liste à l'appui.
 * Hors carte comme `lib/suppression/coeur` : le socle `effets/` l'importe tard, sans tirer le moteur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type Validations = Record<string, { decision?: string; le?: string }>;
const validationsDe = (v: unknown): Validations => {
  const carnet = v && typeof v === "object" ? (v as { carnet?: unknown }).carnet : null;
  const d = lireDossier(carnet);
  return (d?.validations ?? {}) as Validations;
};

export const compenserValidationChantier: NonNullable<PolitiqueAnnulation["metier"]> = async ({ geste, appliquer, user }): Promise<ResultatMetier> => {
  const details: DetailEffet[] = [];
  const traites = new Set<string>();
  const ecritures = geste.effets.filter((e) => e.type === "ECRITURE" && e.modele === "Mission" && e.enregistrementId);
  for (const e of ecritures) {
    // LES CLÉS VALIDÉES PAR CE GESTE : présentes après, absentes avant.
    const avant = validationsDe(e.avant);
    const apres = validationsDe(e.apres);
    const cles = Object.keys(apres).filter((k) => !avant[k]);
    const m = await prisma.mission.findFirst({ where: { id: e.enregistrementId!, kind: "CHANTIER" }, select: { id: true, carnet: true } });
    const d = lireDossier(m?.carnet);
    if (!m || !d || !cles.length) continue;
    for (const x of geste.effets) traites.add(x.id);
    for (const cle of cles) {
      const etape = d.plan.etapes.find((x) => x.cle === cle);
      const quoi = `validation « ${etape?.titre ?? cle} »`;
      const deploye = etape?.type === "RENDER_DEPLOYER" && d.deploiements.some((x) => x.service === etape.service && x.statut === "live");
      const rollback = etape?.type === "RENDER_ROLLBACK" && d.deploiements.some((x) => x.service === etape.service && x.rollback);
      if (etape?.type === "DEV_FUSIONNER" && d.fusion) {
        if (appliquer) await demanderRevertFusion(m.id, user.id);
        details.push({ effetId: e.id, issue: "COMPENSE", quoi: `fusion de la PR #${d.fusion.pr} dans ${d.fusion.base}`, pourquoi: "une PR de revert est ouverte et proposée (jamais un force-push) ; sa fusion repasse par la validation", externe: true });
        continue;
      }
      if (deploye || rollback) {
        details.push({ effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: deploye ? "le déploiement a eu lieu" : "le rollback a eu lieu", aLaPlace: deploye ? "un rollback (carte de validation) ou un nouveau chantier" : "redéployer par un nouveau chantier" });
        continue;
      }
      if (appliquer) {
        await ecrireDossier(m.id, (x) => { delete x.validations[cle]; });
        await prisma.missionStep.updateMany({ where: { missionId: m.id, key: cle, status: { in: ["READY", "WAITING"] } }, data: { status: "WAITING" } });
      }
      details.push({ effetId: e.id, issue: "ANNULE", quoi, pourquoi: "la validation est retirée : le geste attend de nouveau la Direction" });
    }
  }
  return { details, traites };
};
