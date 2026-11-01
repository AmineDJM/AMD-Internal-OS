"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdBool, fdDate, fdStr, type ActionResult } from "@/lib/actions/types";
import { lignes, refusAdresseDuDepot, refusArticle, type ArticleSaisi } from "@/lib/site-web/contrat";
import { refusTitresNiveau1 } from "@/lib/site-web/markdown";
import { retirerDuSite, synchroniserArticle, type ResultatSynchro } from "@/lib/site-web/contenus";
import { leverBlocage, relancerPublication, reveillerFile } from "@/lib/site-web/file";
import { rapprocherSite, verifierSante } from "@/lib/site-web/reconciliation";
import { abandonnerCleEnAttente, genererCle } from "@/lib/site-web/cles";
import { entretenirLiaison } from "@/lib/site-web/liaison";
import { slugsDuDepotConnus } from "@/lib/site-web/etat";
import { peutEcrireArticles, peutGererLaLiaison, peutPublierOffres, peutSupprimerArticles } from "@/lib/site-web/acces";
import { ECRAN_LIAISON, REFUS_LIAISON } from "@/lib/site-web/ecran";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE SITE PUBLIC — les articles de blog, et l'entretien de la publication (§118.158).
 *
 * Toutes les RÈGLES vivent dans `lib/site-web/` (le contrat du site, la lecture du Markdown, la
 * file, la réconciliation) ; ce fichier vérifie les droits, écrit, et met en file. Aucune requête
 * vers le site ne part d'ici : c'est la FILE qui envoie, avec ses réessais et son journal — une
 * action serveur qui attendrait le site ferait patienter une personne dix secondes à chaque
 * enregistrement, et échouerait avec lui.
 *
 * Aucun de ces gestes n'est offert à Adam : publier sur le site public est un geste d'écran, décidé
 * par une personne. La décision est écrite dans `action-registry.ts` (EXCLUDED), et c'est elle que le
 * chemin générique LIT avant de proposer comme avant d'exécuter (`refusDuCheminGenerique`) — une
 * classification que rien ne lisait au moment d'agir ne tenait pas cette phrase (§118.158).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const AUDIT_MODULE = "Site web";
// L'audit porte l'IDENTIFIANT du contenu sans type d'entité, comme la fiche de coaching (§118.157) :
// un `EntityType` de plus ouvrirait la porte polymorphe des pièces jointes, commentaires et tâches
// (`canAccessEntity`) à un objet qui n'en porte aucune — une décision de permission que rien ne demande.
const REFUS_ARTICLES = "Les articles du site se rédigent depuis le module « Site web », en écriture. "
  + "Un Super Admin l'ouvre dans Administration › Comptes.";
const INTENTIONS = ["brouillon", "publier", "enregistrer", "retirer"] as const;
type Intention = (typeof INTENTIONS)[number];

function revalider(id?: string) {
  revalidatePath("/site-web");
  revalidatePath("/site-web/articles");
  revalidatePath(ECRAN_LIAISON.href);
  if (id) revalidatePath(`/site-web/articles/${id}`);
}

/** La phrase qui dit ce qui s'est réellement passé — jamais « publié » avant que le site l'ait confirmé. */
function phraseArticle(intention: Intention, s: ResultatSynchro): string {
  if (s.etat === "BROUILLON") return "Brouillon enregistré — rien n'est envoyé au site tant que l'article n'est pas publié.";
  if (s.etat === "INCHANGE") return `Enregistré. ${s.message}`;
  if (intention === "publier") return "Publication demandée : l'article part vers le site. Son état passe à « En ligne » dès que le site confirme.";
  if (intention === "retirer") return "Retrait demandé : le site le repasse en brouillon, invisible du public (il reste republiable).";
  return "Enregistré : la mise à jour part vers le site.";
}

/**
 * CRÉE OU MODIFIE UN ARTICLE, et le met en file s'il doit être sur le site.
 *
 * `intention` : `brouillon` (jamais envoyé), `publier`, `enregistrer` (garde l'état de
 * publication), `retirer` (le site le garde invisible). Le corps est lu BRUT — `fdStr` le
 * rognerait, et une indentation Markdown (liste imbriquée, code) porte du sens.
 */
export async function enregistrerArticle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "site-web-actions:enregistrerArticle", libelle: "Article enregistré" }, async () => {
    if (!peutEcrireArticles(user)) return { ok: false, error: REFUS_ARTICLES };

    const id = fdStr(formData, "id");
    const intentionBrute = fdStr(formData, "intention") ?? "enregistrer";
    if (!(INTENTIONS as readonly string[]).includes(intentionBrute)) return { ok: false, error: `Geste inconnu : « ${intentionBrute} ».` };
    const intention = intentionBrute as Intention;

    const title = fdStr(formData, "title") ?? "";
    const body = String(formData.get("body") ?? "").replace(/\r\n/g, "\n");
    const description = fdStr(formData, "description");
    const slug = fdStr(formData, "slug");
    const category = fdStr(formData, "category");
    const tags = lignes((fdStr(formData, "tags") ?? "").replace(/,/g, "\n"));
    const author = fdStr(formData, "author");
    const publishedOnSaisie = fdDate(formData, "publishedOn");
    const featured = fdBool(formData, "featured");

    if (!title) return { ok: false, error: "Le titre est obligatoire." };

    const avant = id
      ? await prisma.blogArticle.findUnique({
          where: { id },
          select: { id: true, title: true, body: true, description: true, published: true, publishedOn: true, firstPublishedAt: true, revisedAt: true },
        })
      : null;
    if (id && !avant) return { ok: false, error: "Article introuvable." };
    const dejaEnvoye = avant ? (await prisma.sitePublication.count({ where: { kind: "POST", externalId: avant.id } })) > 0 : false;

    const published = intention === "publier" ? true : intention === "enregistrer" ? (avant?.published ?? false) : false;
    const maintenant = new Date();
    const firstPublishedAt = avant?.firstPublishedAt ?? (published ? maintenant : null);
    // La date affichée : celle que l'auteur fixe, sinon celle déjà posée, sinon la première mise en
    // ligne — et elle ne bouge plus à chaque correction.
    const publishedOn = publishedOnSaisie ?? avant?.publishedOn ?? (published ? firstPublishedAt : null);
    // Une révision d'un article déjà en ligne alimente `dateModified` ; un brouillon qu'on retouche, non.
    const contenuChange = Boolean(avant && (avant.title !== title || avant.body !== body || (avant.description ?? null) !== description));
    const revisedAt = avant?.firstPublishedAt && contenuChange ? maintenant : (avant?.revisedAt ?? null);

    // Ce qui partira vers le site est jugé AVANT d'écrire : un article accepté ici et refusé par le
    // site ferait croire à une publication qui n'aura pas lieu.
    if (published || dejaEnvoye) {
      const saisie: ArticleSaisi = { title, body, description, slug, category, tags, author, date: publishedOn, updated: revisedAt, featured, published };
      const refus = refusArticle(saisie, refusTitresNiveau1(body));
      if (refus.length) return { ok: false, error: refus.join("\n") };
    }
    if (slug) {
      const autre = await prisma.blogArticle.findFirst({ where: { slug, ...(avant ? { NOT: { id: avant.id } } : {}) }, select: { title: true } });
      if (autre) return { ok: false, error: `L'adresse « ${slug} » est déjà celle de l'article « ${autre.title} ».` };
      if (published || dejaEnvoye) {
        const depot = await slugsDuDepotConnus();
        if (depot.slugs.includes(slug)) {
          return { ok: false, error: refusAdresseDuDepot(slug) };
        }
      }
    }

    const data = {
      title, slug, description, body, category, tags, author, publishedOn, firstPublishedAt, revisedAt, featured, published, updatedById: user.id,
    };
    const article = avant
      ? await prisma.blogArticle.update({ where: { id: avant.id }, data, select: { id: true } })
      : await prisma.blogArticle.create({ data: { ...data, createdById: user.id }, select: { id: true } });

    await recordAudit({
      actorId: user.id, action: avant ? "UPDATE" : "CREATE", module: AUDIT_MODULE, entityId: article.id,
      summary: `${intention === "publier" ? "Publication" : intention === "retirer" ? "Retrait du site" : avant ? "Modification" : "Création"} de l'article « ${title} »`,
    });

    const synchro = await synchroniserArticle(article.id, user.id);
    revalider(article.id);
    if (synchro.etat === "REFUSE") return { ok: false, id: article.id, error: synchro.message };
    return { ok: true, id: article.id, message: phraseArticle(intention, synchro) };
  });
}

/**
 * SUPPRIME UN ARTICLE — et le retire du site s'il y était. Le contrat recommande plutôt de le
 * RETIRER (brouillon côté site, republiable) : l'écran le propose d'abord, et la suppression dit
 * ce qu'elle fait.
 */
export async function supprimerArticle(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutSupprimerArticles(user)) return { ok: false, error: "Supprimer un article demande le droit de suppression du module « Site web »." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Article manquant." };
  const a = await prisma.blogArticle.findUnique({
    where: { id }, select: { id: true, title: true, reprise: { select: { origine: true, cleSite: true } } },
  });
  if (!a) return { ok: false, error: "Article introuvable." };

  // La suppression sur le site est mise en file AVANT de retirer la ligne : la ligne de file
  // survit à l'article, et c'est elle qui garantit que le DELETE finira par partir. Un article REPRIS
  // du site (§118.160) la charge de dire quel fichier il remplaçait : lu ici, AVANT la suppression —
  // après, le lien vers la reprise n'existe plus.
  const retrait = await retirerDuSite("POST", a.id, a.title, user.id, a.reprise);
  await prisma.blogArticle.delete({ where: { id: a.id } });
  await recordAudit({ actorId: user.id, action: "DELETE", module: AUDIT_MODULE, entityId: a.id, summary: `Suppression de l'article « ${a.title} »` });
  revalider();
  return { ok: true, message: retrait.enFile ? "Article supprimé. Sa page est retirée du site." : "Article supprimé (il n'était pas sur le site)." };
}

/** RELANCE un envoi en échec — par celui qui a le droit de publier ce contenu. */
export async function relancerEnvoiSite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "site-web-actions:relancerEnvoiSite", libelle: "Envoi au site relancé" }, async () => {
    const publicationId = fdStr(formData, "publicationId");
    if (!publicationId) return { ok: false, error: "Envoi manquant." };
    const p = await prisma.sitePublication.findUnique({ where: { id: publicationId }, select: { kind: true } });
    if (!p) return { ok: false, error: "Envoi introuvable." };
    const permis = p.kind === "JOB" ? peutPublierOffres(user) : peutEcrireArticles(user);
    if (!permis) return { ok: false, error: p.kind === "JOB" ? "Les offres d'emploi se publient par les RH." : REFUS_ARTICLES };
    const r = await relancerPublication(publicationId, user.id);
    revalider();
    revalidatePath("/site-web/offres");
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message };
  });
}

/**
 * VÉRIFIE LA CONNEXION (`GET /health`, le premier point de la mise en service). Si le site
 * reconnaît la clé, un blocage posé sur un 401 est levé : la configuration vient d'être prouvée.
 *
 * Super Admin seulement (§118.160) : le geste présente au site la clé EN ATTENTE, la promeut et lève
 * un blocage — trois effets sur la liaison, qui vit désormais dans la console d'administration.
 */
export async function verifierConnexionSite(): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "site-web-actions:verifierConnexionSite", libelle: "Connexion au site vérifiée" }, async () => {
    if (!peutGererLaLiaison(user)) return { ok: false, error: REFUS_LIAISON };
    // UNE CLÉ EN ATTENTE passe d'abord (§118.159) : c'est presque toujours ce que la personne veut
    // savoir en cliquant — « est-ce que le site a pris la clé que je viens de coller ? ». Le même
    // entretien que le battement, sans attendre son rythme ; il lit aussi la santé du site.
    const l = await entretenirLiaison({ force: true });
    if (l.presentation?.issue === "PROMUE") {
      reveillerFile(0);
      revalider();
      return { ok: true, message: l.presentation.message };
    }
    if (l.presentation && l.presentation.issue !== "PAS_DUE") {
      revalider();
      return { ok: false, error: l.presentation.message };
    }
    const s = await verifierSante();
    if (s.ok && s.authentifie) {
      await leverBlocage();
      reveillerFile(0);
      revalider();
      return {
        ok: true,
        message: `${s.message}${s.heureDuSite ? ` Heure du site : ${s.heureDuSite}.` : ""} Si un blocage était posé, il est levé ; si le site refuse encore les envois, générez une nouvelle clé et collez le bloc ENTIER dans l'environnement du site (il porte aussi le secret de signature).`,
      };
    }
    return { ok: false, error: s.message };
  });
}

/**
 * RAPPROCHE MAINTENANT le site et l'ERP, sans attendre le passage quotidien — le Super Admin, depuis
 * la console (§118.160). Le rapprochement quotidien et celui qui suit un redémarrage du site
 * tournent, eux, sans personne.
 */
export async function rapprocherSiteMaintenant(): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "site-web-actions:rapprocherSiteMaintenant", libelle: "Site rapproché maintenant" }, async () => {
    if (!peutGererLaLiaison(user)) return { ok: false, error: REFUS_LIAISON };
    const b = await rapprocherSite({ declencheur: "MANUEL", parId: user.id });
    revalider();
    revalidatePath("/site-web/offres");
    return b.ok ? { ok: true, message: b.message } : { ok: false, error: b.message };
  });
}

/** LÈVE LE BLOCAGE à la main — le Super Admin, qui tient les variables d'environnement. */
export async function leverBlocageSite(): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutGererLaLiaison(user)) return { ok: false, error: REFUS_LIAISON };
  await leverBlocage();
  reveillerFile(0);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: AUDIT_MODULE, summary: "Blocage de la publication vers le site levé à la main" });
  revalider();
  return { ok: true, message: "Blocage levé : les envois reprennent. Si la clé est toujours refusée, il se reposera au premier envoi." };
}

/**
 * GÉNÈRE LA CLÉ DE LIAISON (§118.159) — la clé et le secret de signature, EN ATTENTE. Rien d'autre
 * ne change : l'ERP continue de publier avec la clé en vigueur jusqu'à ce que le site reconnaisse la
 * nouvelle. L'écran montre alors le bloc à coller ; il ne transite pas par la réponse de l'action.
 *
 * Super Admin seulement : c'est l'identifiant qui donne le droit de publier sur le site public, et
 * §118.6 interdit à Adam d'en créer un — l'action est refusée au chemin générique (EXCLUDED).
 */
export async function genererCleSite(): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "site-web-actions:genererCleSite", libelle: "Clé du site générée" }, async () => {
    if (!peutGererLaLiaison(user)) return { ok: false, error: REFUS_LIAISON };
    const c = await genererCle(user.id);
    revalider();
    return { ok: true, message: `Clé générée (empreinte ${c.empreinte}). Copiez le bloc affiché et collez-le dans l'environnement du site : l'ERP bascule tout seul dès que le site l'a.` };
  });
}

/** ABANDONNE la clé en attente (collée nulle part, ou montrée à la mauvaise personne). L'active ne bouge pas. */
export async function abandonnerCleSite(): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "site-web-actions:abandonnerCleSite", libelle: "Clé du site en attente abandonnée" }, async () => {
    if (!peutGererLaLiaison(user)) return { ok: false, error: REFUS_LIAISON };
    const fait = await abandonnerCleEnAttente(user.id);
    revalider();
    return fait ? { ok: true, message: "Clé en attente abandonnée : elle ne sera jamais acceptée. La clé en vigueur reste la même." } : { ok: false, error: "Aucune clé en attente." };
  });
}
