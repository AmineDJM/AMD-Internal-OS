import { prisma } from "@/lib/prisma";
import { SortieInterdite } from "@/lib/sortie/garde";
import { notifyRoles } from "@/lib/notify";
import {
  classerReponse, lireArticlesDuDepot, lireListeSite, planifierRapprochement, serialiser,
  type PlanRapprochement,
} from "./contrat";
import { configurationEnVigueur } from "./cles";
import { voulusDepuisLaBase } from "./contenus";
import { blocageEnVigueur, bloquerPourConfiguration, empreinteCorps, mettreEnFile, viderFile } from "./file";
import { envoyerAuSite, type ReponseSite, type TransportSite } from "./transport";
import { ECRAN_LIAISON } from "./ecran";
import { lireDepotDuSite } from "./reprise-lecture";
import { reprendreDuSite, repriseImpossible, type BilanReprise } from "./reprise";
import type { CorpsSuppression, EnregistrementSite } from "./contrat";
import { sansBloquer } from "@/lib/journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÉCONCILIATION QUOTIDIENNE AVEC LE SITE (§118.158, contrat §7.5).
 *
 * `GET /jobs` et `GET /posts`, comparés à ce que l'ERP VEUT — recalculé depuis les contenus, pas
 * relu dans la file. Elle rattrape tout ce que la file n'a pas pu tenir : un envoi épuisé, un site
 * redéployé sans disque persistant qui a tout perdu (contrat §9), une étape de recrutement écrite
 * hors des actions.
 *
 *   • ce qui manque ou diverge est REMIS EN FILE (la file envoie, réessaie, journalise) ;
 *   • ce qui a été supprimé ici et survit là-bas voit son DELETE rejoué ;
 *   • ce que le site détient déjà à l'identique est CONFIRMÉ — y compris un envoi que la file
 *     croyait perdu (délai dépassé alors que le site avait bien écrit) ;
 *   • ce que l'ERP ne connaît pas est NOMMÉ, jamais supprimé : un `externalId` absent de la file
 *     n'est pas la preuve qu'on l'a retiré (§118.9 — seul TROUVÉ autorise à agir) ;
 *   • un article masqué par un article du dépôt du site (même slug) est SIGNALÉ : le site répond
 *     200 et ne l'affiche pas, c'est le faux succès que personne ne verrait autrement.
 *
 * Un contenu que le site a REFUSÉ tel quel (4xx) n'est pas repoussé tel quel chaque nuit : il est
 * compté « rejeté », et c'est à une personne de le corriger.
 *
 * ET ELLE REPREND CE QUE LE SITE A ÉCRIT LUI-MÊME (§118.160) : les articles de son dépôt, ses offres
 * d'exemple, les offres saisies dans son administration deviennent des contenus de l'ERP
 * (`reprise.ts`), puis partent remplacer la copie du site par le chemin ordinaire — la file, ses
 * réessais, son journal. Tant que le site ne sait pas rendre son dépôt (ancienne version), le
 * battement repasse toutes les heures au lieu d'une fois par jour, et l'écran le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** La phrase d'un site qui ne sait pas encore rendre son dépôt — elle nomme le geste qui la lève. */
export const SITE_SANS_DEPOT =
  "Le site n'est pas encore à jour : il ne sait pas rendre à l'ERP ses propres articles et offres. Sur Render, « Manual Deploy › Deploy latest commit » ; l'ERP réessaie toutes les heures.";

export const INTERVALLE_RAPPROCHEMENT_MS = 24 * 3_600_000;
/** Un rapprochement qui a échoué (site injoignable) se retente une heure plus tard, pas à chaque minute. */
export const REESSAI_RAPPROCHEMENT_MS = 3_600_000;

export interface BilanRapprochement {
  ok: boolean;
  message: string;
  id: string | null;
  conformes: number;
  repousses: number;
  suppressions: number;
  rejetes: number;
  orphelins: number;
  collisions: number;
  /** La reprise des contenus du site faite à ce passage (§118.160) — nulle quand rien n'a été lu. */
  reprise: BilanReprise | null;
}

const vide = (message: string, id: string | null = null): BilanRapprochement => ({
  ok: false, message, id, conformes: 0, repousses: 0, suppressions: 0, rejetes: 0, orphelins: 0, collisions: 0, reprise: null,
});

function lireJson(texte: string | null): Record<string, unknown> | null {
  if (!texte) return null;
  try {
    const j = JSON.parse(texte) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface OptionsRapprochement {
  declencheur: "AUTO" | "MANUEL";
  parId?: string | null;
  maintenant?: Date;
  transport?: TransportSite;
}

export async function rapprocherSite(opts: OptionsRapprochement): Promise<BilanRapprochement> {
  const maintenant = opts.maintenant ?? new Date();
  const conf = await configurationEnVigueur();
  if (!conf.ok) return vide(conf.raison);
  if (await blocageEnVigueur(conf.config.empreinte)) {
    return vide("Publication suspendue : le site a refusé la configuration. Corrigez-la (ou vérifiez la connexion) avant de rapprocher.");
  }
  const transport = opts.transport ?? envoyerAuSite;
  const ligne = await prisma.siteReconciliation.create({
    data: { trigger: opts.declencheur, byId: opts.parId ?? null, startedAt: maintenant },
    select: { id: true },
  });
  const echec = async (erreur: string): Promise<BilanRapprochement> => {
    await prisma.siteReconciliation.update({ where: { id: ligne.id }, data: { finishedAt: new Date(), ok: false, error: erreur.slice(0, 1_000) } });
    return vide(erreur, ligne.id);
  };

  // ── Lire ce que le site détient ──────────────────────────────────────────────────────
  const lus: { jobs?: Record<string, unknown>; posts?: Record<string, unknown> } = {};
  for (const [cle, chemin] of [["jobs", "/jobs"], ["posts", "/posts"]] as const) {
    let rep: ReponseSite;
    try {
      rep = await transport({ methode: "GET", chemin });
    } catch (e) {
      if (e instanceof SortieInterdite) return echec("Sortie interdite dans ce processus (test ou banc) : le site n'a pas été interrogé.");
      return echec(`GET ${chemin} : ${e instanceof Error ? e.message : String(e)}`);
    }
    const issue = classerReponse("GET", rep.statut);
    if (issue === "BLOQUANT") return echec(await bloquerPourConfiguration(conf.config.empreinte, rep, maintenant));
    if (issue !== "SUCCES") {
      return echec(`GET ${chemin} : ${rep.statut === null ? (rep.erreur ?? "site injoignable") : `réponse ${rep.statut}`}. Nouvel essai dans une heure.`);
    }
    const json = lireJson(rep.texte);
    if (!json) return echec(`GET ${chemin} : réponse illisible (pas un objet JSON). Rien n'a été comparé.`);
    lus[cle] = json;
  }

  const jobs = lireListeSite(lus.jobs!.jobs);
  const posts = lireListeSite(lus.posts!.posts);
  const depot = lireArticlesDuDepot(lus.posts!.readOnlyFileArticles);
  if (!Array.isArray(lus.jobs!.jobs) || !Array.isArray(lus.posts!.posts)) {
    // Une réponse sans liste n'est pas « le site n'a rien » : tout repousser sur cette foi-là
    // serait inoffensif pour le site (PUT idempotents) mais ferait croire à une perte de données.
    return echec("Le site a répondu sans la liste attendue (`jobs` ou `posts`) : rien n'a été comparé.");
  }

  // ── Reprendre ce que le site a écrit lui-même (§118.160) — AVANT de calculer ce que l'ERP veut :
  //    les contenus repris en font partie, et partent remplacer la copie du site dans ce passage.
  const reprise = await lireEtReprendre(transport, jobs.enregistrements, opts.parId ?? null, maintenant);
  const reprisIds = new Set(reprise.repris.map((r) => `${r.nature}:${r.id}`));

  // ── Comparer à ce que l'ERP veut, et appliquer ───────────────────────────────────────
  const voulus = await voulusDepuisLaBase();
  const plan = planifierRapprochement(voulus, { jobs: jobs.enregistrements, posts: posts.enregistrements, depot });
  const cle = (nature: string, externalId: string) => `${nature}:${externalId}`;
  const voulusParCle = new Map(voulus.map((v) => [cle(v.nature, v.externalId), v] as const));
  const lignes = await prisma.sitePublication.findMany({
    select: { id: true, kind: true, externalId: true, operation: true, state: true, body: true, bodyHash: true, lastStatus: true, claimedAt: true },
  });
  const lignesParCle = new Map(lignes.map((l) => [cle(l.kind, l.externalId), l] as const));

  let repousses = 0;
  let reprisEnvoyes = 0;
  let rejetes = 0;
  let suppressions = 0;
  const ecarts: { nature: string; externalId: string; libelle: string; raison: string }[] = [];

  for (const p of plan.aPousser) {
    const v = voulusParCle.get(cle(p.nature, p.externalId));
    if (!v?.corps) continue;
    const hash = empreinteCorps(serialiser(v.corps));
    const l = lignesParCle.get(cle(p.nature, p.externalId));
    const refuseTelQuel = l && l.state === "FAILED" && l.lastStatus !== null && l.lastStatus >= 400 && l.lastStatus < 500 && l.bodyHash === hash;
    if (refuseTelQuel) {
      rejetes += 1;
      ecarts.push({ nature: p.nature, externalId: p.externalId, libelle: p.libelle, raison: `${p.raison} — non repoussé : le site a refusé ce contenu tel quel (${l!.lastStatus})` });
      continue;
    }
    const r = await mettreEnFile({ nature: p.nature, externalId: p.externalId, libelle: p.libelle, operation: "PUT", corps: v.corps, forcer: true });
    // Un contenu tout juste REPRIS n'est pas un écart rattrapé : c'est la version de l'ERP qui part
    // remplacer celle du site. Le compter parmi les « repoussés » ferait lire une panne là où il n'y
    // en a pas.
    const repris = reprisIds.has(cle(p.nature, p.externalId));
    if (r.enFile) {
      if (repris) reprisEnvoyes += 1;
      else repousses += 1;
    }
    ecarts.push({ nature: p.nature, externalId: p.externalId, libelle: p.libelle, raison: repris ? "repris du site — la version de l'ERP part remplacer celle du site" : p.raison });
  }

  // Connus de l'ERP mais refusés par le contrat du site dans leur état actuel : ni repoussés, ni
  // orphelins — nommés, parce qu'une personne doit les corriger (et c'est la seule issue).
  for (const v of voulus) {
    if (v.operation !== "PUT" || v.corps) continue;
    rejetes += 1;
    ecarts.push({ nature: v.nature, externalId: v.externalId, libelle: v.libelle, raison: `non envoyé : ${v.refus ?? "contenu refusé par le contrat du site"}` });
  }

  for (const s of plan.aSupprimer) {
    // Une suppression de contenu REPRIS garde le corps qu'elle portait (ce qu'elle remplaçait) : la
    // rejouer sans lui laisserait le site sans la consigne de cacher sa propre copie.
    const l = lignesParCle.get(cle(s.nature, s.externalId));
    const corps = l?.operation === "DELETE" && l.body ? lireCorpsSuppression(l.body) : null;
    const r = await mettreEnFile({ nature: s.nature, externalId: s.externalId, libelle: s.libelle, operation: "DELETE", corps, forcer: true });
    if (r.enFile) suppressions += 1;
    ecarts.push({ nature: s.nature, externalId: s.externalId, libelle: s.libelle, raison: "supprimé dans l'ERP, encore présent sur le site" });
  }

  for (const c of plan.conformes) {
    const v = voulusParCle.get(cle(c.nature, c.externalId));
    const l = lignesParCle.get(cle(c.nature, c.externalId));
    if (!v) continue;
    if (v.operation === "PUT" && v.corps) {
      const hash = empreinteCorps(serialiser(v.corps));
      if (!l) {
        // Voulu en ligne, déjà en ligne à l'identique, mais sans ligne de file : on l'inscrit,
        // pour que l'écran dise « En ligne » au lieu de « À envoyer ».
        await prisma.sitePublication.create({
          data: {
            kind: c.nature, externalId: c.externalId, label: v.libelle, operation: "PUT", body: serialiser(v.corps), bodyHash: hash,
            state: "DONE", attempts: 0, confirmedHash: hash, confirmedPublished: v.corps.published, confirmedAt: maintenant,
            siteUrl: c.url, siteSlug: c.slug,
          },
        }).catch(sansBloquer("reconciliation.rapprocherSite.sitePublication"));
        continue;
      }
      // La ligne décrit la version voulue et le site la détient : c'est FAIT — même si l'envoi a
      // été déclaré perdu (délai dépassé alors que le site avait bien écrit). Une ligne en vol
      // n'est pas touchée : son envoi dira lui-même ce qu'il en est.
      if (l.operation === "PUT" && l.bodyHash === hash && l.state !== "DONE" && !l.claimedAt) {
        await prisma.sitePublication.updateMany({
          where: { id: l.id, bodyHash: hash, claimedAt: null },
          data: { state: "DONE", confirmedHash: hash, confirmedPublished: v.corps.published, confirmedAt: maintenant, siteUrl: c.url, siteSlug: c.slug, lastError: null },
        });
      } else if (l.state === "DONE" && c.url) {
        await prisma.sitePublication.updateMany({ where: { id: l.id, siteUrl: null }, data: { siteUrl: c.url, siteSlug: c.slug } });
      }
    } else if (l && l.operation === "DELETE" && l.state !== "DONE" && !l.claimedAt && !l.bodyHash) {
      // (Une suppression de contenu REPRIS — elle porte un corps — n'est pas « faite » parce que le
      // site ne détient pas l'enregistrement : elle doit encore lui dire de cacher SA copie. La file
      // l'enverra ; c'est sa réponse qui la clôt.)
      await prisma.sitePublication.updateMany({
        where: { id: l.id, operation: "DELETE", claimedAt: null },
        data: { state: "DONE", confirmedHash: null, confirmedPublished: null, confirmedAt: maintenant, siteUrl: null, siteSlug: null, lastError: null },
      });
    }
  }

  // ── Un article repris puis SUPPRIMÉ dans l'ERP que le site montre encore (§118.160) : le site a
  //    perdu la consigne de le cacher (redémarré sans disque pendant que l'ERP était injoignable).
  //    On lui demande de recharger ses contenus — la liste des fichiers à cacher en fait partie.
  const rechargement = await rechargerSiFichierSupprimeVisible(transport, depot.map((d) => d.slug));

  const illisibles = jobs.illisibles + posts.illisibles;
  await prisma.siteReconciliation.update({
    where: { id: ligne.id },
    data: {
      finishedAt: new Date(), ok: true,
      error: illisibles ? `${illisibles} élément(s) de la réponse du site illisible(s) — ignorés, et comptés ici.` : null,
      siteJobs: jobs.enregistrements.length, sitePosts: posts.enregistrements.length,
      conformes: plan.conformes.length, repousses, suppressions, rejetes,
      orphelins: plan.orphelins, collisions: plan.collisions, ecarts, manuels: plan.manuels,
      depotSlugs: depot.map((d) => d.slug),
      repriseLue: reprise.lue, repris: reprise.repris.length,
      reprise: {
        impossible: reprise.impossible, repris: reprise.repris, aCorriger: reprise.aCorriger, conflits: reprise.conflits,
        illisibles: reprise.illisibles, rechargement,
      },
    },
  });

  await signalerNouveautes(ligne.id, maintenant, plan);

  // Les repoussés partent maintenant, par la file — avec ses réessais et son journal.
  if (repousses || suppressions || reprisEnvoyes) await viderFile({ transport: opts.transport, maintenant: opts.maintenant });

  const morceaux = [
    `${plan.conformes.length} conforme(s)`,
    reprise.repris.length ? `${reprise.repris.length} contenu(s) repris du site` : null,
    reprise.aCorriger.length ? `${reprise.aCorriger.length} repris à corriger avant de remplacer la version du site` : null,
    reprise.conflits.length ? `${reprise.conflits.length} non repris (adresse déjà prise dans l'ERP)` : null,
    reprise.impossible ? `reprise impossible — ${reprise.impossible}` : null,
    repousses ? `${repousses} repoussé(s)` : null,
    suppressions ? `${suppressions} suppression(s) rejouée(s)` : null,
    rejetes ? `${rejetes} refusé(s) par le site, à corriger` : null,
    plan.orphelins.length ? `${plan.orphelins.length} inconnu(s) de l'ERP sur le site (non supprimés)` : null,
    plan.collisions.length ? `${plan.collisions.length} article(s) masqué(s) par un article du dépôt du site` : null,
  ].filter(Boolean);
  return {
    ok: true, message: `Rapprochement fait : ${morceaux.join(", ")}.`, id: ligne.id,
    conformes: plan.conformes.length, repousses, suppressions, rejetes, orphelins: plan.orphelins.length, collisions: plan.collisions.length,
    reprise,
  };
}

/** Relit le corps d'une suppression de contenu repris — `null` sur tout ce qui ne se lit pas à coup sûr. */
function lireCorpsSuppression(body: string): CorpsSuppression | null {
  const j = lireJson(body);
  if (typeof j?.replacesFile === "string" && j.replacesFile) return { replacesFile: j.replacesFile };
  if (typeof j?.replacesJob === "string" && j.replacesJob) return { replacesJob: j.replacesJob };
  return null;
}

/**
 * LIT LE DÉPÔT DU SITE ET REPREND ce que l'ERP n'en connaît pas (§118.160). Ne fait jamais échouer le
 * rapprochement : une reprise impossible est DITE (site pas à jour, réponse illisible) et le reste du
 * rapprochement se fait quand même.
 */
async function lireEtReprendre(
  transport: TransportSite, jobsDuSite: readonly EnregistrementSite[], parId: string | null, maintenant: Date,
): Promise<BilanReprise> {
  let rep: ReponseSite;
  try {
    rep = await transport({ methode: "GET", chemin: "/repository" });
  } catch (e) {
    if (e instanceof SortieInterdite) return repriseImpossible("Sortie interdite dans ce processus (test ou banc) : le dépôt du site n'a pas été lu.");
    return repriseImpossible(`GET /repository : ${e instanceof Error ? e.message : String(e)}`);
  }
  // Un site d'avant la reprise ne connaît pas cette adresse : 404. Ce n'est pas une panne.
  if (rep.statut === 404) return repriseImpossible(SITE_SANS_DEPOT);
  if (rep.statut !== 200) {
    return repriseImpossible(`Le site n'a pas rendu son dépôt (${rep.statut === null ? (rep.erreur ?? "site injoignable") : `réponse ${rep.statut}`}) : nouvel essai au prochain rapprochement.`);
  }
  const depot = lireDepotDuSite(lireJson(rep.texte));
  if (!depot) return repriseImpossible("Le site a rendu son dépôt sous une forme illisible : rien n'a été repris.");
  return reprendreDuSite({ depot, manuels: jobsDuSite.filter((j) => !j.externalId), parId, maintenant });
}

/**
 * UN FICHIER REPRIS PUIS SUPPRIMÉ, ENCORE VISIBLE ? Le site a perdu la liste des fichiers à cacher :
 * on lui demande de recharger ses contenus depuis l'ERP (`POST /resync`), qui la lui redonne. Rien
 * n'est tenté quand tout est en ordre — un rechargement n'est pas un geste gratuit pour le site.
 */
async function rechargerSiFichierSupprimeVisible(
  transport: TransportSite, depotVisible: readonly string[],
): Promise<{ fichiers: string[]; statut: number | null; message: string } | null> {
  if (!depotVisible.length) return null;
  const supprimes = await prisma.siteReprise.findMany({
    where: { origine: "ARTICLE_DEPOT", articleId: null, cleSite: { in: [...depotVisible] } },
    select: { cleSite: true },
  });
  if (!supprimes.length) return null;
  const fichiers = supprimes.map((r) => r.cleSite).sort();
  let rep: ReponseSite;
  try {
    rep = await transport({ methode: "POST", chemin: "/resync", corps: "" });
  } catch (e) {
    return { fichiers, statut: null, message: e instanceof SortieInterdite ? "Sortie interdite dans ce processus : aucun rechargement demandé." : String(e) };
  }
  const message = rep.statut === 200 || rep.statut === 202
    ? "Le site recharge ses contenus : les articles supprimés dans l'ERP disparaissent de son blog."
    : rep.statut === 429
      ? "Le site vient de recharger ses contenus : nouvel essai au prochain rapprochement."
      : rep.statut === 404
        ? SITE_SANS_DEPOT
        : `Rechargement refusé (${rep.statut ?? rep.erreur ?? "site injoignable"}) : nouvel essai au prochain rapprochement.`;
  return { fichiers, statut: rep.statut, message };
}

/**
 * PRÉVENIR, MAIS SEULEMENT DE CE QUI EST NOUVEAU. Un orphelin ou une collision déjà signalés la
 * veille ne refont pas une notification chaque nuit — une alerte permanente devient du bruit, et
 * l'on cesse de la lire (§118.32).
 */
async function signalerNouveautes(id: string, debut: Date, plan: PlanRapprochement): Promise<void> {
  if (!plan.orphelins.length && !plan.collisions.length) return;
  // LE PRÉCÉDENT est le dernier rapprochement réussi AVANT celui-ci — pas « le plus récent en
  // base ». Mesuré : un rapprochement daté plus tard (un banc qui joue le lendemain, une instance
  // dont l'horloge avance) devenait la référence, ses orphelins ne contenaient pas ceux du jour,
  // et la même alerte repartait à chaque passage — le bruit exact que cette fonction existe pour
  // éviter (§118.32). « Déjà signalé » veut dire signalé par un passage ANTÉRIEUR.
  const precedent = await prisma.siteReconciliation.findFirst({
    where: { ok: true, id: { not: id }, startedAt: { lt: debut } },
    orderBy: { startedAt: "desc" },
    select: { orphelins: true, collisions: true },
  });
  const deja = (json: unknown): Set<string> =>
    new Set(Array.isArray(json) ? json.map((x) => (x && typeof x === "object" ? String((x as { externalId?: unknown }).externalId ?? "") : "")) : []);
  const orphelinsVus = deja(precedent?.orphelins);
  const collisionsVues = deja(precedent?.collisions);
  const nouveauxOrphelins = plan.orphelins.filter((o) => !orphelinsVus.has(o.externalId));
  const nouvellesCollisions = plan.collisions.filter((c) => !collisionsVues.has(c.externalId));
  const phrases: string[] = [];
  if (nouvellesCollisions.length) {
    phrases.push(`${nouvellesCollisions.map((c) => `« ${c.libelle} » (adresse /blog/${c.slug})`).join(", ")} : le site affiche à la place l'article de son dépôt « ${nouvellesCollisions[0]!.titreDuDepot} »${nouvellesCollisions.length > 1 ? " (et d'autres)" : ""}. Donnez à l'article une autre adresse.`);
  }
  if (nouveauxOrphelins.length) {
    phrases.push(`${nouveauxOrphelins.length} contenu(s) présent(s) sur le site sont inconnus de l'ERP (${nouveauxOrphelins.slice(0, 3).map((o) => `« ${o.titre} »`).join(", ")}${nouveauxOrphelins.length > 3 ? "…" : ""}) — ils n'ont pas été supprimés.`);
  }
  if (phrases.length) await notifyRoles(["SUPER_ADMIN"], { type: "GENERIC", title: "Site web : rapprochement à regarder", body: phrases.join(" "), link: "/site-web" });
}

let rapprochementEnCours = false;

/**
 * LE PAS DU BATTEMENT : un rapprochement par jour, et un nouvel essai une heure après un échec.
 * L'instant se relit en base : un redémarrage ne provoque pas de rapprochement de plus, et
 * plusieurs instances qui se croiseraient ne font rien de dangereux — chaque écriture est
 * idempotente (mise en file par contenu, PUT sur `externalId`).
 */
export async function rapprocherSiteSiDu(maintenant: Date = new Date(), transport?: TransportSite): Promise<BilanRapprochement | null> {
  if (process.env.SITE_WEB_RECONCILIATION === "off") return null;
  if (rapprochementEnCours) return null;
  if (!(await configurationEnVigueur()).ok) return null;
  const [dernierOk, dernier, depotDejaLu] = await Promise.all([
    prisma.siteReconciliation.findFirst({ where: { ok: true }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    prisma.siteReconciliation.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true, ok: true } }),
    prisma.siteReconciliation.findFirst({ where: { ok: true, repriseLue: true }, select: { id: true } }),
  ]);
  // TANT QUE LE DÉPÔT DU SITE N'A JAMAIS ÉTÉ LU (§118.160) — ERP tout juste déployé, site pas encore
  // à jour —, le rapprochement repasse toutes les heures au lieu d'une fois par jour : la reprise des
  // contenus du site ne doit pas attendre le lendemain, et elle se fait dès que le site sait répondre.
  const intervalle = depotDejaLu ? INTERVALLE_RAPPROCHEMENT_MS : REESSAI_RAPPROCHEMENT_MS;
  if (dernierOk && maintenant.getTime() - dernierOk.startedAt.getTime() < intervalle) return null;
  if (dernier && !dernier.ok && maintenant.getTime() - dernier.startedAt.getTime() < REESSAI_RAPPROCHEMENT_MS) return null;
  rapprochementEnCours = true;
  try {
    return await rapprocherSite({ declencheur: "AUTO", maintenant, transport });
  } finally {
    rapprochementEnCours = false;
  }
}

// ───────────────────────────── Vérifier la connexion ─────────────────────────────

export interface Sante {
  ok: boolean;
  message: string;
  configure: boolean | null;
  authentifie: boolean | null;
  capacites: string[];
  heureDuSite: string | null;
}

/**
 * `GET /health` avec la clé : le site dit s'il est configuré (`ERP_API_KEY` posée chez lui) et si
 * la clé envoyée est la bonne. C'est le premier point de la mise en service (contrat §10).
 */
export async function verifierSante(transport: TransportSite = envoyerAuSite): Promise<Sante> {
  const base: Sante = { ok: false, message: "", configure: null, authentifie: null, capacites: [], heureDuSite: null };
  const conf = await configurationEnVigueur();
  if (!conf.ok) return { ...base, message: conf.raison };
  let rep: ReponseSite;
  try {
    rep = await transport({ methode: "GET", chemin: "/health" });
  } catch (e) {
    return { ...base, message: e instanceof SortieInterdite ? "Sortie interdite dans ce processus (test ou banc) : le site n'a pas été interrogé." : String(e) };
  }
  if (rep.statut === null) return { ...base, message: `Site injoignable : ${rep.erreur ?? "aucune réponse"}.` };
  if (rep.statut === 401) {
    // Le site vérifie la clé AVANT la signature : un refus de signature veut dire « bonne clé,
    // autre secret » — presque toujours un bloc collé en partie. Deux réparations, deux phrases.
    const signature = /signature/i.test(String(lireJson(rep.texte)?.error ?? ""));
    return {
      ...base,
      authentifie: false,
      message: signature
        ? "Le site reconnaît la clé mais refuse la signature (401) : son secret de signature n'est pas celui du bloc. Générez une nouvelle clé et collez le bloc ENTIER (les trois lignes) dans l'environnement du site."
        : `Le site refuse la clé (401) : il en porte une autre. Générez une nouvelle clé depuis ${ECRAN_LIAISON.nom} et collez le bloc dans l'environnement du site (Render).`,
    };
  }
  if (rep.statut >= 300 && rep.statut < 400) return { ...base, message: `Le site redirige (${rep.statut}${rep.location ? ` vers ${rep.location}` : ""}) : l'adresse du site n'est pas la bonne (ADVENTUM_BASE_URL).` };
  const j = lireJson(rep.texte);
  if (rep.statut !== 200 || !j) return { ...base, message: `Réponse inattendue du site (${rep.statut}).` };
  const configure = typeof j.configured === "boolean" ? j.configured : null;
  const authentifie = typeof j.authenticated === "boolean" ? j.authenticated : null;
  const capacites = Array.isArray(j.capabilities) ? j.capabilities.filter((c): c is string => typeof c === "string") : [];
  const heureDuSite = typeof j.serverTime === "string" ? j.serverTime : null;
  const lu = { ...base, configure, authentifie, capacites, heureDuSite };
  if (configure === false) return { ...lu, message: `Le site n'a pas de clé : générez-la depuis ${ECRAN_LIAISON.nom} et collez le bloc affiché dans l'environnement du site (Render).` };
  if (authentifie === false) return { ...lu, message: "Le site est configuré mais ne reconnaît pas la clé envoyée : générez une nouvelle clé et collez le bloc dans l'environnement du site." };
  const manque = ["jobs", "posts"].filter((c) => capacites.length > 0 && !capacites.includes(c));
  if (manque.length) return { ...lu, message: `Connexion établie, mais le site n'annonce pas : ${manque.join(", ")}.` };
  return { ...lu, ok: true, message: `Connexion établie : clé reconnue${capacites.length ? ` (capacités : ${capacites.join(", ")})` : ""}.` };
}
