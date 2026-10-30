import { Prisma } from "@prisma/client";
import type { CurrentUser } from "@/lib/session";
import { prismaBrut } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { composer, type Changement, type EtatActuel } from "@/lib/annulation/plan";
import { classerGeste, natureDe as natureDuJournal, type NatureGeste } from "@/lib/annulation/reversibilite";
import { construireDiff, natureDe } from "./diff";
import type { Capture, EcritureCapturee, EffetExterneCapture } from "./magasin";
import { infoModele, type InfoModele } from "./modeles";
import { cleDeValeur, memeValeur, serialiserLigne, valeurLisible } from "./valeurs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ANNULATION HONNÊTE D'UN GESTE DE L'ASSISTANT (J7, décision 0029) — sur le journal des effets.
 *
 * Pour chaque effet d'un geste, du plus récent au plus ancien, UNE des quatre issues, avec sa raison :
 *
 *   • ANNULÉ — l'effet est défait : un champ remis à sa valeur d'avant (invariant de `annulation/plan.ts` : SEULEMENT
 *     si la valeur actuelle est encore celle que le geste a écrite) ; une ligne créée retirée (intacte, et rien ne
 *     s'y est rattaché) ; une ligne supprimée recréée à l'identique, MÊME identifiant (rien n'avait suivi en cascade).
 *   • COMPENSÉ — l'effet ne se retire pas mais un geste inverse le neutralise (`annulation/reversibilite.ts`) : une
 *     ligne créée à laquelle on a touché depuis passe à son statut d'annulation, la trace reste.
 *   • IMPOSSIBLE — et POURQUOI : quelqu'un a changé la valeur depuis (son travail n'est jamais écrasé), un courriel
 *     est parti, une écriture en lot n'a pas d'identifiants… avec ce qu'on peut faire à la place.
 *   • SANS OBJET — l'effet n'existe déjà plus (retiré par ailleurs).
 *
 * ── LA COURSE, FERMÉE À L'ÉCRITURE ───────────────────────────────────────────────────────
 *
 * Le plan se compose sur l'état lu ; l'écriture se fait ligne par ligne dans une transaction qui VERROUILLE la ligne
 * (`FOR UPDATE`), la RELIT, et n'écrit que si chaque champ vaut encore ce que le geste y avait laissé. Une valeur
 * changée entre le plan et l'écriture sort en IMPOSSIBLE — jamais écrasée.
 *
 * ── QUI ──────────────────────────────────────────────────────────────────────────────────
 *
 * La personne au nom de qui le geste s'est fait (elle avait le droit de le faire, elle défait ses effets directs), ou
 * le Super Admin. Une annulation est elle-même un changement : elle va à l'audit, et le geste garde son compte rendu.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type IssueEffet = "ANNULE" | "COMPENSE" | "IMPOSSIBLE" | "SANS_OBJET";

export interface DetailEffet {
  effetId: string;
  issue: IssueEffet;
  /** La phrase de l'effet : « tâche « Stand » créée », « courriel à … ». */
  quoi: string;
  pourquoi: string;
  /** Ce qu'on peut faire à la place, quand c'est impossible. */
  aLaPlace?: string | null;
}

export interface CompteRenduAnnulation {
  gesteId: string;
  libelle: string;
  details: DetailEffet[];
  compte: Record<IssueEffet, number>;
  /** VRAI seulement si tout ce qui pouvait l'être est défait ou compensé (et rien n'est impossible). */
  complet: boolean;
  resume: string;
}

type Delegue = {
  findUnique: (a: unknown) => Promise<Record<string, unknown> | null>;
  count: (a: unknown) => Promise<number>;
  update: (a: unknown) => Promise<unknown>;
  delete: (a: unknown) => Promise<unknown>;
  create: (a: unknown) => Promise<unknown>;
};
type Client = Record<string, unknown>;

interface EffetLu {
  id: string; ordre: number; type: string; modele: string | null; operation: string | null; enregistrementId: string | null;
  avant: unknown; apres: unknown; champs: string[]; cascade: number | null; nombre: number | null; imbriquee: boolean;
  acte: string | null; cible: string | null; apercu: string | null;
}

const delegue = (c: Client, info: InfoModele) => c[info.delegue] as Delegue;
const ligne = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Une valeur sérialisée, rendue au type de son champ pour l'écrire. `undefined` : elle ne se restaure pas. */
function deserialiser(info: InfoModele, champ: string, v: unknown): unknown {
  const t = info.types.get(champ);
  if (!t) return undefined;
  const un = (x: unknown): unknown => {
    if (x === null) return null;
    if (x && typeof x === "object") {
      const o = x as Record<string, unknown>;
      if ("$date" in o) return o.$date === null ? null : new Date(String(o.$date));
      if ("$decimal" in o) return new Prisma.Decimal(String(o.$decimal));
      if ("$bigint" in o) return BigInt(String(o.$bigint));
      if ("$octets" in o) return undefined;
    }
    return x;
  };
  if (t.type === "Json") return v === null ? (t.obligatoire ? Prisma.JsonNull : Prisma.DbNull) : v;
  if (t.liste) return Array.isArray(v) ? v.map(un) : v;
  return un(v);
}

/** La ligne telle qu'elle est maintenant, sérialisée (scalaires sans octets) — `null` si elle n'existe plus. */
async function lireActuelle(c: Client, info: InfoModele, id: string): Promise<Record<string, unknown> | null> {
  if (!info.cle) return null;
  const r = await delegue(c, info).findUnique({ where: { [info.cle]: id } }).catch(() => null);
  return serialiserLigne(r, new Set(info.scalaires));
}

/**
 * L'ÉCRITURE VERROUILLÉE — la ligne est verrouillée (`FOR UPDATE`), RELUE, et l'écriture n'a lieu que si `verifier`
 * accepte la relecture. Rend `false` si la ligne a bougé entre le plan et l'écriture (ou si la base refuse).
 */
async function ecrireVerrouille(
  info: InfoModele, id: string, verifier: (relue: Record<string, unknown> | null) => boolean, ecrire: (t: Client) => Promise<unknown>,
): Promise<boolean> {
  return (prismaBrut.$transaction(async (tx) => {
    const t = tx as unknown as Client;
    await verrouiller(t, info, id);
    if (!verifier(await lireActuelle(t, info, id))) return false;
    await ecrire(t);
    return true;
  }) as Promise<boolean>).catch(() => false);
}

async function verrouiller(tx: Client, info: InfoModele, id: string): Promise<void> {
  const t = tx as { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number> };
  await t.$executeRawUnsafe(`SELECT 1 FROM "${info.table.replace(/"/g, "")}" WHERE "${(info.cleColonne ?? "id").replace(/"/g, "")}" = $1 FOR UPDATE`, id);
}

/** Les lignes qui POINTENT vers celle-ci (hors celles créées par le même geste, défaites avant elle). */
async function rattaches(c: Client, info: InfoModele, id: string, ignorer: ReadonlySet<string>): Promise<{ n: number; quoi: string[] }> {
  let n = 0;
  const quoi: string[] = [];
  for (const e of info.enfants) {
    const d = c[e.delegue] as Delegue | undefined;
    const enfant = infoModele(e.modele);
    if (!d || !enfant?.cle) continue;
    const exclus = [...ignorer];
    const k = await d.count({ where: { [e.champ]: id, ...(exclus.length ? { NOT: { [enfant.cle]: { in: exclus } } } : {}) } }).catch(() => 0);
    if (k) { n += k; quoi.push(`${k} ${natureDe(e.modele)}`); }
  }
  return { n, quoi };
}

const OCTETS = new Set(["FileBlob", "FileBlobChunk", "StoredFile"]);

const ACTE_NATURE: Readonly<Record<string, NatureGeste>> = {
  COURRIEL: "MESSAGE_ENVOYE", NOTIFICATION_PUSH: "MESSAGE_ENVOYE", INVITATION_AGENDA: "MESSAGE_ENVOYE", PAIEMENT: "PAIEMENT_EXECUTE",
};

function enCapture(effets: readonly EffetLu[]): Capture {
  return {
    ecritures: effets.filter((e) => e.type === "ECRITURE").map((e) => ({
      modele: e.modele ?? "?", operation: (e.operation ?? "SQL") as EcritureCapturee["operation"], id: e.enregistrementId,
      avant: ligne(e.avant), apres: ligne(e.apres), champs: e.champs, cascade: e.cascade ?? undefined, nombre: e.nombre ?? undefined, imbriquee: e.imbriquee,
    })),
    effets: effets.filter((e) => e.type === "EXTERNE").map((e) => ({ acte: (e.acte ?? "RESEAU") as EffetExterneCapture["acte"], cible: e.cible ?? "", apercu: e.apercu ?? undefined, neutralise: false })),
  };
}

const phraseEcriture = (e: EffetLu): string => {
  const d = construireDiff(enCapture([e]), { debut: 0, fin: 0 });
  return d.lignes[0]?.phrase ?? (e.operation === "SQL" ? "une écriture SQL directe" : `${natureDe(e.modele ?? "")} ${e.operation?.toLowerCase() ?? ""}`);
};

/** L'issue d'un effet EXTERNE : il est sorti — rien ici ne le reprend. */
function issueExterne(e: EffetLu): DetailEffet {
  const quoi = construireDiff(enCapture([e]), { debut: 0, fin: 0 }).effets[0]?.phrase ?? "un effet externe";
  if (e.acte === "STOCKAGE") {
    return { effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "les octets déposés ne servent plus si la pièce est retirée : la purge des fichiers orphelins les efface", aLaPlace: null };
  }
  const nature = ACTE_NATURE[e.acte ?? ""];
  const v = nature ? classerGeste(nature) : null;
  const pourquoi = v?.raison
    ?? (e.acte === "ECRITURE_EXTERNE" ? "la publication est partie sur le site Adventum : elle ne se reprend pas d'ici" : "l'appel est parti vers un service extérieur : rien ici ne peut le reprendre");
  const aLaPlace = v?.compensation
    ?? (e.acte === "ECRITURE_EXTERNE" ? "retirer ou corriger la publication depuis l'écran du site" : "prévenir le destinataire de l'appel par son canal habituel");
  return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi, aLaPlace };
}

interface Contexte {
  c: Client;
  agent: string;
  creeLe: Date;
  crees: Set<string>;
  appliquer: boolean;
  nomDe: (id: string | null | undefined) => Promise<string | null>;
}

/** Les champs MODIFIÉS d'une ligne : l'invariant de `plan.ts`, puis l'écriture verrouillée. */
async function defaireModification(e: EffetLu, info: InfoModele, ctx: Contexte): Promise<DetailEffet> {
  const quoi = phraseEcriture(e);
  const id = e.enregistrementId!;
  const avant = ligne(e.avant) ?? {};
  const apres = ligne(e.apres) ?? {};
  const champs = e.champs.filter((c) => !info.auto.has(c) && info.types.has(c));
  if (!champs.length) return { effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "seuls des horodatages avaient changé" };
  const actuelle = await lireActuelle(ctx.c, info, id);
  if (!actuelle) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `${natureDe(e.modele!)} n'existe plus : il n'y a plus rien à remettre`, aLaPlace: null };
  const resume = (c: string) => `${e.modele}.${c} → ${valeurLisible(apres[c])}`;
  const changements: Changement[] = champs.map((c) => ({
    id: `${e.id}:${c}`, auteurId: null, auteurNom: ctx.agent, parAdam: true, quand: ctx.creeLe, action: "UPDATE",
    module: e.modele!, entite: e.modele, entiteId: id, champ: c, avant: cleDeValeur(avant[c] ?? null), apres: cleDeValeur(apres[c] ?? null), resume: resume(c),
  }));
  const etats: EtatActuel[] = champs.map((c) => ({ entite: e.modele!, entiteId: id, champ: c, valeur: cleDeValeur(actuelle[c] ?? null) }));
  const plan = composer(changements, etats, [], ctx.agent);
  const aRemettre = plan.gestes.map((g) => g.champ);
  const refuses = plan.ecartes.map((x) => {
    const c = x.changementId.slice(e.id.length + 1);
    if (x.motif === "MODIFIE_DEPUIS") return `« ${c} » vaut maintenant « ${valeurLisible(actuelle[c])} » (le geste y avait mis « ${valeurLisible(apres[c])} »)`;
    return `« ${c} » : ${x.explication}`;
  });
  let ecrits: string[] = [];
  if (aRemettre.length && ctx.appliquer) {
    ecrits = await (prismaBrut.$transaction(async (tx) => {
      const t = tx as unknown as Client;
      await verrouiller(t, info, id);
      const relue = await lireActuelle(t, info, id);
      const ok = aRemettre.filter((c) => relue && memeValeur(relue[c] ?? null, apres[c] ?? null));
      const data: Record<string, unknown> = {};
      for (const c of ok) {
        const v = deserialiser(info, c, avant[c] ?? null);
        if (v !== undefined) data[c] = v;
      }
      if (Object.keys(data).length) await delegue(t, info).update({ where: { [info.cle!]: id }, data });
      return Object.keys(data);
    }) as Promise<string[]>);
    for (const c of aRemettre.filter((x) => !ecrits.includes(x))) refuses.push(`« ${c} » a changé au moment même de l'annulation : laissé tel quel`);
  } else {
    ecrits = aRemettre;
  }
  const remis = ecrits.map((c) => `« ${c} » remis à « ${valeurLisible(avant[c])} »`);
  if (!ecrits.length) {
    return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `${refuses.join(" ; ")} — quelqu'un a changé ces valeurs depuis : les remettre effacerait son travail`, aLaPlace: "reprendre la valeur voulue à la main, en connaissance du changement" };
  }
  return {
    effetId: e.id, issue: "ANNULE", quoi,
    pourquoi: refuses.length ? `${remis.join(", ")} ; mais ${refuses.join(" ; ")} — laissé(s) tel(s) quel(s)` : remis.join(", "),
    aLaPlace: refuses.length ? "reprendre à la main les champs laissés, en connaissance du changement" : null,
  };
}

/** Une ligne CRÉÉE : retirée si intacte et sans rattachement ; sinon compensée par son statut d'annulation. */
async function defaireCreation(e: EffetLu, info: InfoModele, ctx: Contexte): Promise<DetailEffet> {
  const quoi = phraseEcriture(e);
  const id = e.enregistrementId!;
  const apres = ligne(e.apres) ?? {};
  const actuelle = await lireActuelle(ctx.c, info, id);
  if (!actuelle) return { effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "elle a déjà été retirée par ailleurs" };
  const touches = Object.keys(apres).filter((c) => !info.auto.has(c) && info.types.has(c) && !memeValeur(actuelle[c] ?? null, apres[c] ?? null));
  const lies = await rattaches(ctx.c, info, id, ctx.crees);
  const verdict = classerGeste("ENREGISTREMENT_CREE");
  if (e.modele === "Notification" && actuelle.isRead === true) {
    const qui = await ctx.nomDe(String(actuelle.userId ?? ""));
    return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `${qui ?? "son destinataire"} l'a déjà lue : la retirer ne reprendrait pas l'information`, aLaPlace: "lui envoyer un mot de rectification" };
  }
  if (!touches.length && !lies.n) {
    if (ctx.appliquer) {
      const fait = await ecrireVerrouille(info, id,
        (relue) => !!relue && !Object.keys(apres).some((c) => !info.auto.has(c) && info.types.has(c) && !memeValeur(relue[c] ?? null, apres[c] ?? null)),
        (t) => delegue(t, info).delete({ where: { [info.cle!]: id } }));
      if (!fait) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "elle a changé au moment même de l'annulation (ou une ligne y tient encore) : laissée telle quelle", aLaPlace: verdict.compensation };
    }
    const lue = e.modele === "Notification" ? " avant d'avoir été lue" : "";
    return { effetId: e.id, issue: "ANNULE", quoi, pourquoi: `retirée${lue} : personne n'y avait touché et rien ne s'y était rattaché` };
  }
  const raison = [
    touches.length ? `modifiée depuis (${touches.slice(0, 4).map((c) => `« ${c} »`).join(", ")})` : "",
    lies.n ? `${lies.quoi.join(", ")} s'y ${lies.n > 1 ? "sont" : "est"} rattaché${lies.n > 1 ? "s" : ""} depuis` : "",
  ].filter(Boolean).join(" ; ");
  // LA COMPENSATION : le statut d'annulation, seulement si le statut lui-même n'a pas bougé depuis.
  const a = info.annulation;
  if (a && memeValeur(actuelle[a.champ] ?? null, apres[a.champ] ?? null) && actuelle[a.champ] !== a.valeur) {
    if (ctx.appliquer) {
      const fait = await ecrireVerrouille(info, id,
        (relue) => !!relue && memeValeur(relue[a.champ] ?? null, apres[a.champ] ?? null),
        (t) => delegue(t, info).update({ where: { [info.cle!]: id }, data: { [a.champ]: a.valeur } }));
      if (!fait) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `${raison} ; et son statut a changé au moment même de l'annulation`, aLaPlace: verdict.compensation };
    }
    return { effetId: e.id, issue: "COMPENSE", quoi, pourquoi: `${raison} — la retirer effacerait ce travail : passée à ${a.valeur}, la trace reste, l'effet cesse` };
  }
  return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `${raison} — ${verdict.raison}`, aLaPlace: a ? `son statut a changé depuis : la clore à la main depuis son écran` : verdict.compensation };
}

/** Une ligne SUPPRIMÉE : recréée à l'identique (même identifiant), si rien n'a suivi en cascade. */
async function defaireSuppression(e: EffetLu, info: InfoModele, ctx: Contexte): Promise<DetailEffet> {
  const quoi = phraseEcriture(e);
  const id = e.enregistrementId!;
  const avant = ligne(e.avant);
  const verdict = classerGeste("ENREGISTREMENT_SUPPRIME");
  if (!avant) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "le journal ne porte pas la ligne supprimée", aLaPlace: verdict.compensation };
  if (e.cascade) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `${e.cascade} élément(s) lié(s) ont été supprimés avec elle, en cascade, et ne sont pas au journal : la recréer seule laisserait un dossier amputé`, aLaPlace: verdict.compensation };
  if (await lireActuelle(ctx.c, info, id)) return { effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "une ligne porte de nouveau cet identifiant : elle a été rétablie par ailleurs" };
  const data: Record<string, unknown> = {};
  for (const [c, v] of Object.entries(avant)) {
    if (!info.types.has(c)) continue;
    const x = deserialiser(info, c, v);
    if (x === undefined) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: `« ${c} » portait un fichier, que le journal ne recopie pas`, aLaPlace: verdict.compensation };
    data[c] = x;
  }
  const manquants = info.octets.filter((c) => info.types.get(c)?.obligatoire && !info.types.get(c)?.defaut);
  if (manquants.length) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "la ligne portait des octets, que le journal ne recopie pas", aLaPlace: verdict.compensation };
  if (ctx.appliquer) {
    try {
      await delegue(prismaBrut as unknown as Client, info).create({ data });
    } catch (err) {
      const code = (err as { code?: string }).code;
      const pourquoi = code === "P2003" ? "un élément auquel elle était rattachée a disparu depuis"
        : code === "P2002" ? "une autre ligne occupe désormais sa place (valeur unique déjà prise)"
          : "la base a refusé de la recréer";
      return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi, aLaPlace: verdict.compensation };
    }
  }
  return { effetId: e.id, issue: "ANNULE", quoi, pourquoi: "recréée à l'identique, avec le même identifiant : les liens vers elle tiennent de nouveau" };
}

async function issueEffet(e: EffetLu, ctx: Contexte): Promise<DetailEffet> {
  if (e.type === "EXTERNE") return issueExterne(e);
  const quoi = phraseEcriture(e);
  if (e.operation === "SQL" && OCTETS.has(e.modele ?? "")) {
    return { effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "compteur de références des octets d'une pièce : la purge des fichiers orphelins s'en charge" };
  }
  if (e.operation === "SQL" || !e.enregistrementId) {
    return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: e.operation === "SQL" ? "une écriture SQL directe n'est pas détaillée au journal" : "une écriture en lot n'a pas d'identifiants au journal : on ne sait pas quelles lignes défaire", aLaPlace: "reprendre à la main depuis l'écran concerné" };
  }
  const info = infoModele(e.modele ?? "");
  if (!info || !info.cle) return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: "cette table n'a pas de clé simple : la ligne ne se désigne pas", aLaPlace: "reprendre à la main depuis l'écran concerné" };
  // UN CHANGEMENT DE STATUT QUI VAUT PAIEMENT, DÉPÔT OU SIGNATURE ne se « remet » pas : la table de réversibilité tranche.
  if (e.operation === "UPDATE") {
    const apres = ligne(e.apres) ?? {};
    for (const c of e.champs) {
      const nature = natureDuJournal({ action: "UPDATE", module: e.modele, resume: `${c} ${valeurLisible(apres[c])}`, champ: c });
      const v = classerGeste(nature);
      if (nature !== "CHAMP_MODIFIE" && v.reversibilite !== "REVERSIBLE") {
        return { effetId: e.id, issue: "IMPOSSIBLE", quoi, pourquoi: v.raison, aLaPlace: v.compensation ?? v.delegueA };
      }
    }
    return defaireModification(e, info, ctx);
  }
  // LES OCTETS D'UNE PIÈCE (blob, tranches) : comptés par références, retirés par la purge des orphelins dès que plus
  // rien n'y renvoie — les supprimer ici casserait une autre pièce qui partagerait les mêmes octets (dédoublonnage).
  if (e.operation === "CREATE" && OCTETS.has(e.modele ?? "")) {
    return { effetId: e.id, issue: "SANS_OBJET", quoi, pourquoi: "octets d'une pièce, partagés par empreinte : la purge des fichiers orphelins les retire dès que plus rien n'y renvoie" };
  }
  if (e.operation === "CREATE") return defaireCreation(e, info, ctx);
  return defaireSuppression(e, info, ctx);
}

function conclure(gesteId: string, libelle: string, details: DetailEffet[], deja: boolean): CompteRenduAnnulation {
  const compte: Record<IssueEffet, number> = { ANNULE: 0, COMPENSE: 0, IMPOSSIBLE: 0, SANS_OBJET: 0 };
  for (const d of details) compte[d.issue]++;
  const complet = compte.IMPOSSIBLE === 0;
  const parts = [
    compte.ANNULE ? `${compte.ANNULE} annulé(s)` : "",
    compte.COMPENSE ? `${compte.COMPENSE} compensé(s)` : "",
    compte.IMPOSSIBLE ? `${compte.IMPOSSIBLE} impossible(s)` : "",
    compte.SANS_OBJET ? `${compte.SANS_OBJET} sans objet` : "",
  ].filter(Boolean);
  const verbe = deja ? "Prévu" : "Fait";
  const resume = details.length === 0
    ? "Ce geste n'a rien laissé à défaire."
    : `${verbe} : ${parts.join(", ")} sur ${details.length} effet(s).${complet ? "" : " Ce n'est PAS une annulation complète : chaque effet dit pourquoi."}`;
  return { gesteId, libelle, details, compte, complet, resume };
}

async function charger(gesteId: string, user: CurrentUser) {
  const g = await prismaBrut.assistantGesteJournal.findUnique({ where: { id: gesteId }, include: { effets: { orderBy: { ordre: "desc" } } } });
  if (!g) return { refus: "Ce geste n'est plus au journal (durée de garde dépassée, ou jamais journalisé)." } as const;
  if (g.principalId !== user.id && user.role !== "SUPER_ADMIN") return { refus: "Seule la personne au nom de qui l'assistant a agi (ou le Super Admin) peut défaire ce geste." } as const;
  return { g } as const;
}

const nomsEnCache = () => {
  const cache = new Map<string, string | null>();
  return async (id: string | null | undefined) => {
    if (!id) return null;
    if (!cache.has(id)) cache.set(id, (await prismaBrut.user.findUnique({ where: { id }, select: { name: true } }).catch(() => null))?.name ?? null);
    return cache.get(id) ?? null;
  };
};

async function derouler(g: { id: string; libelle: string; creeLe: Date; effets: EffetLu[] }, appliquer: boolean): Promise<CompteRenduAnnulation> {
  // Les lignes créées par ce geste et RETIRÉES (ou à retirer) : elles ne comptent pas comme rattachement de leur parent.
  const retirees = new Set<string>();
  const ctx: Contexte = { c: prismaBrut as unknown as Client, agent: "l'assistant", creeLe: g.creeLe, crees: retirees, appliquer, nomDe: nomsEnCache() };
  const details: DetailEffet[] = [];
  // DU PLUS RÉCENT AU PLUS ANCIEN (`plan.ts`) : l'enfant créé après son parent est défait avant lui. Le SQL brut, lui,
  // se juge en DERNIER : il suit ce qu'est devenue la ligne dont sa table dépend.
  const sql = g.effets.filter((e) => e.type === "ECRITURE" && e.operation === "SQL");
  for (const e of g.effets.filter((x) => !sql.includes(x))) {
    const d = await issueEffet(e, ctx).catch((err): DetailEffet => ({
      effetId: e.id, issue: "IMPOSSIBLE", quoi: e.type === "EXTERNE" ? e.cible ?? "effet" : phraseEcriture(e),
      pourquoi: `l'annulation a échoué sur cet effet (${err instanceof Error ? err.message.slice(0, 160) : String(err)}) — rien n'y a été écrit`, aLaPlace: null,
    }));
    if (e.operation === "CREATE" && d.issue === "ANNULE" && e.enregistrementId) retirees.add(e.enregistrementId);
    details.push(d);
  }
  // UNE ÉCRITURE SQL sur une table qui suit en CASCADE une ligne née de ce geste, et retirée : partie avec elle.
  const parentsRetires = new Set(g.effets.filter((e) => e.operation === "CREATE" && e.enregistrementId && retirees.has(e.enregistrementId)).map((e) => e.modele ?? ""));
  for (const e of sql) {
    const suit = [...parentsRetires].some((p) => infoModele(p)?.cascades.some((c) => c.modele === e.modele));
    details.push(suit
      ? { effetId: e.id, issue: "SANS_OBJET", quoi: phraseEcriture(e), pourquoi: `écriture SQL sur ${natureDe(e.modele ?? "")}, qui suit en cascade une ligne née de ce geste et retirée` }
      : await issueEffet(e, ctx));
  }
  return conclure(g.id, g.libelle, details, !appliquer);
}

/** CE QUE L'ANNULATION FERAIT — sans rien écrire (l'écran le montre avant le clic). */
export async function planDAnnulation(gesteId: string, user: CurrentUser): Promise<CompteRenduAnnulation | { refus: string }> {
  const r = await charger(gesteId, user);
  if ("refus" in r) return { refus: r.refus! };
  if (r.g.annuleLe) return { refus: `Ce geste a déjà été annulé le ${r.g.annuleLe.toLocaleDateString("fr-FR")}.` };
  return derouler(r.g, false);
}

/** ANNULER un geste de l'assistant — détail par effet, jamais un « annulé » de façade. */
export async function annulerGeste(gesteId: string, user: CurrentUser): Promise<CompteRenduAnnulation | { refus: string }> {
  const r = await charger(gesteId, user);
  if ("refus" in r) return { refus: r.refus! };
  // LA RÉCLAMATION ATOMIQUE : une seule annulation par geste, même en deux onglets.
  const prise = await prismaBrut.assistantGesteJournal.updateMany({ where: { id: gesteId, annuleLe: null }, data: { annuleLe: new Date(), annuleParId: user.id } });
  if (prise.count !== 1) return { refus: "Ce geste a déjà été annulé (ou l'est en ce moment même, depuis un autre écran)." };
  const compte = await derouler(r.g, true);
  await prismaBrut.assistantGesteJournal.update({ where: { id: gesteId }, data: { annulation: compte as unknown as Prisma.InputJsonValue } });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "ASSISTANT_IA", entityId: gesteId,
    summary: `Annulation d'un geste de l'assistant (« ${r.g.libelle} ») — ${compte.resume}`.slice(0, 500),
  });
  return compte;
}

export interface GesteListe {
  id: string;
  quand: string;
  origine: string;
  libelle: string;
  resultat: string;
  message: string | null;
  resume: string;
  ecart: boolean;
  annuleLe: string | null;
  annulation: CompteRenduAnnulation | null;
  principal: string | null;
}

/** « CE QUE L'ASSISTANT A FAIT » — les gestes d'une personne (le Super Admin : de tous), les plus récents d'abord. */
export async function gestesDeLAssistant(user: CurrentUser, opts: { tous?: boolean; limite?: number } = {}): Promise<GesteListe[]> {
  const tous = opts.tous && user.role === "SUPER_ADMIN";
  const gestes = await prismaBrut.assistantGesteJournal.findMany({
    where: tous ? {} : { principalId: user.id },
    orderBy: { creeLe: "desc" }, take: Math.min(200, opts.limite ?? 50),
    include: { effets: { orderBy: { ordre: "asc" } } },
  });
  const noms = new Map((await prismaBrut.user.findMany({ where: { id: { in: [...new Set(gestes.map((g) => g.principalId))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return gestes.map((g) => ({
    id: g.id, quand: g.creeLe.toISOString(), origine: g.origine, libelle: g.libelle, resultat: g.resultat, message: g.message,
    resume: g.effets.length ? construireDiff(enCapture(g.effets), { debut: 0, fin: 0 }).resume : "Aucune écriture.",
    ecart: g.ecart, annuleLe: g.annuleLe?.toISOString() ?? null,
    annulation: (g.annulation as unknown as CompteRenduAnnulation | null) ?? null,
    principal: noms.get(g.principalId) ?? null,
  }));
}
