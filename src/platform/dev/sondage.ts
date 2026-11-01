import type { FaitDev, ForgeGit, Hebergeur, NomDepot, PasDeSondage, Resultat } from "./ports";
import { STATUTS_DEPLOIEMENT_FINAUX } from "./ports";
import { inscrireFaits, type BilanReception, type Inscrire } from "./reception";
import { cleChecks, cleDeploiement, clePush, statutFinalRender } from "./webhooks";

/**
 * LE SONDAGE DE SECOURS (lot C2) — quand un webhook manque (non configuré, livraison perdue, Render qui a désactivé
 * le webhook après huit échecs), l'étape `DEV_ATTENDRE` / `RENDER_DEPLOYER` du moteur sonde à PAS CROISSANT.
 *
 * Chaque sonde rend des `FaitDev` à la MÊME clé sémantique que le webhook (`clePush`, `cleDeploiement`) : un fait vu
 * des deux côtés ne s'inscrit qu'une fois. Les lectures GitHub répétées passent par l'ETag (304 gratuit au quota).
 * Une erreur de quota remonte avec son délai : le moteur l'ajoute au pas.
 */

export const PAS_DEFAUT: PasDeSondage = { premierMs: 30_000, facteur: 2, maxMs: 15 * 60_000 };

/** Le délai avant la `tentative`-ième sonde (0 = la première) : 30 s, 1 min, 2 min… plafonné à 15 min. */
export function delaiSondage(tentative: number, pas: PasDeSondage = PAS_DEFAUT, quotaMs?: number | null): number {
  const base = Math.min(pas.maxMs, Math.round(pas.premierMs * pas.facteur ** Math.max(0, tentative)));
  return Math.max(base, quotaMs ?? 0);
}

const fait = (f: Partial<FaitDev> & Pick<FaitDev, "type" | "fournisseur" | "cle" | "brut">): FaitDev => ({
  depot: null, branche: null, sha: null, numeroPr: null, serviceId: null, deployId: null, statut: null, auteur: null, url: null, survenuLe: null, ...f,
});

/** Un commit NOUVEAU sur la branche (tête ≠ `depuisSha`) → `DEV_PUSH`. */
export async function sonderBranche(forge: ForgeGit, depot: NomDepot, branche: string, depuisSha: string | null): Promise<Resultat<FaitDev[]>> {
  const r = await forge.teteDeBranche(depot, branche);
  if (!r.ok) return r;
  const sha = r.valeur;
  if (!sha || sha === depuisSha) return { ok: true, valeur: [] };
  return { ok: true, valeur: [fait({ type: "DEV_PUSH", fournisseur: "github", cle: clePush(depot, branche, sha), brut: "sondage.branche", depot, branche, sha })] };
}

/** Les checks d'un SHA TERMINÉS (verts ou rouges) → `DEV_CHECKS` avec le verdict global. En cours : rien. */
export async function sonderChecks(forge: ForgeGit, depot: NomDepot, sha: string, branche: string | null = null): Promise<Resultat<FaitDev[]>> {
  const r = await forge.checks(depot, sha);
  if (!r.ok) return r;
  if (r.valeur.global !== "VERT" && r.valeur.global !== "ROUGE") return { ok: true, valeur: [] };
  const statut = r.valeur.global === "VERT" ? "success" : "failure";
  return { ok: true, valeur: [fait({ type: "DEV_CHECKS", fournisseur: "github", cle: cleChecks(depot, sha, statut), brut: "sondage.checks", depot, branche, sha, statut })] };
}

/** Un déploiement Render ARRIVÉ à un statut final → `RENDER_DEPLOIEMENT` (`succeeded` / `failed` / `canceled`). */
export async function sonderDeploiement(hebergeur: Hebergeur, serviceId: string, deployId: string): Promise<Resultat<FaitDev[]>> {
  const r = await hebergeur.deploiement(serviceId, deployId);
  if (!r.ok) return r;
  const d = r.valeur;
  if (!(STATUTS_DEPLOIEMENT_FINAUX as readonly string[]).includes(d.statut)) return { ok: true, valeur: [] };
  const statut = statutFinalRender(d.statut);
  if (!statut) return { ok: true, valeur: [] }; // `deactivated` : remplacé, ce n'est pas une issue du déploiement suivi
  return { ok: true, valeur: [fait({ type: "RENDER_DEPLOIEMENT", fournisseur: "render", cle: cleDeploiement(deployId, statut), brut: `sondage.${d.statut}`, serviceId, deployId, sha: d.sha, statut, survenuLe: d.termineLe })] };
}

/** Sonde puis inscrit (dédoublonné avec les webhooks). L'erreur du fournisseur remonte telle quelle. */
export async function sonderEtInscrire(sonde: Promise<Resultat<FaitDev[]>>, inscrire: Inscrire): Promise<Resultat<BilanReception>> {
  const r = await sonde;
  if (!r.ok) return r;
  return { ok: true, valeur: await inscrireFaits(r.valeur, inscrire, "sondage") };
}
