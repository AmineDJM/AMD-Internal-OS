import type { Prisma } from "@prisma/client";
import { prismaBrut } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { CurrentUser } from "@/lib/session";
import { delegue, deserialiser, ecrireVerrouille, ligne, lireActuelle, retablirParLeJournal, type Client, type CompteRenduAnnulation, type DetailEffet } from "./annulation";
import { annulerEffetSortant, rejouerEffetFait, retablirEffetSortant } from "./fenetre";
import { infoModele, type InfoModele } from "./modeles";
import { memeValeur } from "./valeurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RÉTABLIR — UNE ANNULATION EST ELLE-MÊME ANNULABLE (K10b, décision 0040).
 *
 * `retablirGeste(gesteId, user)` relit le compte rendu de l'annulation et refait, du plus ANCIEN au plus récent, ce
 * qu'elle avait défait — sous la même règle que l'annulation : on ne réécrit une valeur que si la ligne est encore
 * dans l'état où l'annulation l'a laissée (verrou, relecture). Ce qui a bougé depuis est DIT, jamais écrasé.
 *
 *   • champ remis           → la valeur du geste réécrite (si le champ vaut encore la valeur d'avant) ;
 *   • ligne créée, retirée  → recréée à l'identique, même identifiant ;
 *   • ligne compensée       → son statut d'avant rendu (si elle porte encore le statut d'annulation) ;
 *   • ligne recréée         → retirée de nouveau (si personne n'y a touché) ;
 *   • envoi annulé          → il repart pour une fenêtre neuve ; un rectificatif encore en fenêtre est retenu.
 *
 * Après, le geste se ré-annule (son `annuleLe` est levé) ; le journal d'audit garde les trois gestes.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface EffetLu {
  id: string; type: string; modele: string | null; operation: string | null; enregistrementId: string | null;
  avant: unknown; apres: unknown; champs: string[]; effetSortantId: string | null;
}

const OK = (d: DetailEffet, pourquoi: string): DetailEffet => ({ ...d, issue: "ANNULE", pourquoi, aLaPlace: null });
const NON = (d: DetailEffet, pourquoi: string): DetailEffet => ({ ...d, issue: "IMPOSSIBLE", pourquoi, aLaPlace: "reprendre à la main depuis l'écran concerné" });
const RIEN = (d: DetailEffet, pourquoi: string): DetailEffet => ({ ...d, issue: "SANS_OBJET", pourquoi, aLaPlace: null });

const champsReels = (info: InfoModele, l: Record<string, unknown>) => Object.keys(l).filter((c) => !info.auto.has(c) && info.types.has(c));

async function refaire(e: EffetLu, d: DetailEffet, user: CurrentUser): Promise<DetailEffet> {
  if (e.type === "EXTERNE") {
    if (!e.effetSortantId) return RIEN(d, "effet externe : l'annulation n'y avait rien défait");
    if (d.issue === "ANNULE") {
      const r = await retablirEffetSortant(e.effetSortantId, user);
      return r.ok ? OK(d, r.message) : RIEN(d, r.message);
    }
    // Compensé : un geste externe défait (lu, déplacé…) est rejoué ; un rectificatif encore en fenêtre est retenu ;
    // parti, il ne se reprend pas.
    const l = await prismaBrut.effetSortantDiffere.findUnique({ where: { id: e.effetSortantId }, select: { compensation: true, type: true } });
    if (l?.type.startsWith("inverse.")) {
      const r = await rejouerEffetFait(e.effetSortantId, user);
      return r.ok ? OK(d, r.message) : NON(d, r.message);
    }
    const rect = /\[([a-z0-9]+)\]$/.exec(l?.compensation ?? "")?.[1];
    if (!rect) return NON(d, "le courriel d'origine est parti et sa compensation aussi : ni l'un ni l'autre ne se reprend");
    const r = await annulerEffetSortant(rect, user, { compenser: false });
    return r.issue === "ANNULE" ? OK(d, "le rectificatif attendait encore sa fenêtre : retenu, il ne partira pas") : NON(d, `le rectificatif est déjà parti : ${r.message}`);
  }
  const info = infoModele(e.modele ?? "");
  const id = e.enregistrementId;
  if (!info?.cle || !id) return NON(d, "cette écriture ne se désigne pas");
  const avant = ligne(e.avant) ?? {};
  const apres = ligne(e.apres) ?? {};
  const c = prismaBrut as unknown as Client;
  if (e.operation === "UPDATE") {
    const champs = e.champs.filter((x) => !info.auto.has(x) && info.types.has(x));
    const data: Record<string, unknown> = {};
    for (const x of champs) { const v = deserialiser(info, x, apres[x] ?? null); if (v !== undefined) data[x] = v; }
    const fait = await ecrireVerrouille(info, id, (r) => !!r && champs.every((x) => memeValeur(r[x] ?? null, avant[x] ?? null)), (t) => delegue(t, info).update({ where: { [info.cle!]: id }, data }));
    return fait ? OK(d, `rétabli : ${champs.map((x) => `« ${x} »`).join(", ")} rendu(s) à la valeur du geste`) : NON(d, "la ligne a changé depuis l'annulation : la valeur du geste n'est pas réécrite par-dessus");
  }
  if (e.operation === "CREATE") {
    if (d.issue === "COMPENSE" && info.annulation) {
      const a = info.annulation;
      const v = deserialiser(info, a.champ, apres[a.champ] ?? null);
      const fait = await ecrireVerrouille(info, id, (r) => !!r && r[a.champ] === a.valeur, (t) => delegue(t, info).update({ where: { [info.cle!]: id }, data: { [a.champ]: v } }));
      return fait ? OK(d, `rétablie : son statut d'avant l'annulation lui est rendu`) : NON(d, "son statut a changé depuis l'annulation : laissé tel quel");
    }
    if (await lireActuelle(c, info, id)) return RIEN(d, "elle existe déjà de nouveau");
    const data: Record<string, unknown> = {};
    for (const x of champsReels(info, apres).concat([...info.auto].filter((x) => x in apres && info.types.has(x)))) {
      const v = deserialiser(info, x, apres[x] ?? null);
      if (v === undefined) return NON(d, `« ${x} » portait un fichier, que le journal ne recopie pas`);
      data[x] = v;
    }
    try { await delegue(c, info).create({ data }); } catch { return NON(d, "la base a refusé de la recréer (un élément lié a disparu, ou sa place est prise)"); }
    return OK(d, "recréée à l'identique, même identifiant");
  }
  if (e.operation === "DELETE") {
    const fait = await ecrireVerrouille(info, id, (r) => !!r && champsReels(info, avant).every((x) => memeValeur(r[x] ?? null, avant[x] ?? null)), (t) => delegue(t, info).delete({ where: { [info.cle!]: id } }));
    return fait ? OK(d, "retirée de nouveau, comme le geste l'avait fait") : NON(d, "elle a changé (ou une ligne s'y est rattachée) depuis son rétablissement : laissée");
  }
  return NON(d, "écriture non rétablissable");
}

/** RÉTABLIR un geste annulé — le compte rendu, effet par effet ; le geste redevient annulable. */
export async function retablirGeste(gesteId: string, user: CurrentUser): Promise<CompteRenduAnnulation | { refus: string }> {
  const g = await prismaBrut.assistantGesteJournal.findUnique({ where: { id: gesteId }, include: { effets: { orderBy: { ordre: "asc" } } } });
  if (!g) return { refus: "Ce geste n'est plus au journal." };
  if (g.principalId !== user.id && user.role !== "SUPER_ADMIN") return { refus: "Seule la personne au nom de qui le geste s'est fait (ou le Super Admin) peut le rétablir." };
  const compte = g.annulation as unknown as CompteRenduAnnulation | null;
  if (!g.annuleLe || !compte) return { refus: "Ce geste n'est pas annulé : rien à rétablir." };
  // K10c : une annulation JOURNALISÉE (son geste porte ce qu'elle a écrit, gestes inverses métier compris) se rétablit
  // en annulant ce geste-là — la corbeille remise, le rectificatif non lu retiré —, plutôt qu'effet par effet.
  if (compte.gesteAnnulationId) {
    const r = await retablirParLeJournal(gesteId, user);
    if ("refus" in r) return r;
    // Les envois retenus dans leur fenêtre (ou compensés) par l'annulation : ils repartent (fenêtre neuve), comme K10b.
    const parEffet = new Map(compte.details.map((d) => [d.effetId, d]));
    for (const e of g.effets) {
      const d = parEffet.get(e.id);
      if (e.type !== "EXTERNE" || !e.effetSortantId || !d || (d.issue !== "ANNULE" && d.issue !== "COMPENSE")) continue;
      const fait = await refaire(e, d, user).catch((err): DetailEffet => NON(d, `le rétablissement a échoué sur cet effet (${err instanceof Error ? err.message.slice(0, 160) : String(err)})`));
      r.details.push(fait);
      r.compte[fait.issue]++;
    }
    return r;
  }
  // LA RÉCLAMATION ATOMIQUE : un seul rétablissement, même en deux onglets.
  const prise = await prismaBrut.assistantGesteJournal.updateMany({ where: { id: gesteId, annuleLe: g.annuleLe }, data: { annuleLe: null, annuleParId: null } });
  if (prise.count !== 1) return { refus: "Ce geste est rétabli (ou l'est en ce moment même, depuis un autre écran)." };
  const parEffet = new Map(compte.details.map((d) => [d.effetId, d]));
  const details: DetailEffet[] = [];
  for (const e of g.effets) {
    const d = parEffet.get(e.id);
    if (!d || (d.issue !== "ANNULE" && d.issue !== "COMPENSE")) continue;
    details.push(await refaire(e, d, user).catch((err): DetailEffet => NON(d, `le rétablissement a échoué sur cet effet (${err instanceof Error ? err.message.slice(0, 160) : String(err)})`)));
  }
  const n = { ANNULE: 0, COMPENSE: 0, IMPOSSIBLE: 0, SANS_OBJET: 0 };
  for (const d of details) n[d.issue]++;
  const complet = n.IMPOSSIBLE === 0;
  const resume = details.length
    ? `Rétabli : ${n.ANNULE} effet(s) refait(s)${n.IMPOSSIBLE ? `, ${n.IMPOSSIBLE} impossible(s)` : ""}${n.SANS_OBJET ? `, ${n.SANS_OBJET} sans objet` : ""}.${complet ? "" : " Ce n'est PAS un rétablissement complet : chaque effet dit pourquoi."}`
    : "L'annulation n'avait rien défait : rien à rétablir.";
  const rendu: CompteRenduAnnulation = { gesteId, libelle: g.libelle, details, compte: n, complet, resume };
  await prismaBrut.assistantGesteJournal.update({ where: { id: gesteId }, data: { annulation: { ...rendu, retabli: true, annulationPrecedente: compte } as unknown as Prisma.InputJsonValue } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "ASSISTANT_IA", entityId: gesteId, summary: `Rétablissement d'un geste annulé (« ${g.libelle} ») — ${resume}`.slice(0, 500) });
  return rendu;
}
