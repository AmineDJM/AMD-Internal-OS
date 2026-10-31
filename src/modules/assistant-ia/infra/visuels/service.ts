import type { AssistantIaVisuel, Prisma } from "@prisma/client";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import type { WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { driveNodeToFile, resolveDriveFile } from "@/platform/ia/drive";
import { avertirPersonne, depenseVisuelsDuMois, journaliserVisuel, porteurCourant, refusSiIaCoupee } from "../consommation";
import {
  consigneAvecCharte, coutImageUsd, coutVideoUsd, DOSSIER_VISUELS, dureeVideo, filtrerConsigne, MODELE_IMAGE_SECOURS,
  nomDeFichierVisuel, normaliserReglagesVisuels, refusCoupe, refusPlafond, routeVisuel, vueVisuel,
  type NatureVisuel, type ReglagesVisuels, type VueVisuel,
} from "../../domaine/visuels/regles";
import type { SpecVideoDonnees } from "../../domaine/visuels/video-donnees";
import { etatModeleVideo, imageGemini, imageOpenAI, lancerVideo, suivreVideo, telechargerVideo, type ImageSource } from "./fournisseurs";
import { rendrePossible, rendreVideoDonnees } from "./rendu-donnees";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES VISUELS DE L'ASSISTANT IA (lot K2, décision 0032) — le moteur.
 *
 * Chaque génération prend les mêmes portes, dans le même ordre, AVANT de rien dépenser :
 *   1. le réglage du Super Admin (interrupteur de la nature) ;  2. l'interrupteur GÉNÉRAL de l'IA ;
 *   3. le filtre de la consigne (aucune donnée confidentielle ne part) ;  4. le PLAFOND du mois (coût réel journalisé).
 * Puis le fichier va au DRIVE de la personne (dossier « Visuels de l'assistant », inscrit à la Bibliothèque), la ligne
 * `AssistantIaVisuel` garde l'état et le coût, et la réponse reçoit un bloc `visuel` (image dans la réponse, carte « en
 * cours » pour une vidéo).
 *
 * LES VIDÉOS SONT LONGUES : lancées, elles rendent la main ; la tâche de fond `assistant.visuels` les suit
 * (`traiterVisuelsEnFile`), dépose le fichier et prévient la personne. La famille « Images & vidéos générées » de la
 * console (`VISUELS`) est jugée par l'outil (`outils-v1.ts`), avant ce module.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export async function lireReglagesVisuels(): Promise<ReglagesVisuels> {
  const r = await prisma.assistantIaReglage.findUnique({ where: { id: "global" } }).catch(sansBloquer("visuels.reglages", null));
  return normaliserReglagesVisuels(r as unknown as Record<string, unknown> | null);
}

/** Ce que l'écran d'administration montre : les réglages et la dépense du mois de chaque route payante. */
export async function etatVisuelsPourAdministration(): Promise<{
  reglages: ReglagesVisuels; depenseImagesUsd: number; depenseVideosUsd: number; videoIndisponible: string | null;
}> {
  const [reglages, depenseImagesUsd, depenseVideosUsd] = await Promise.all([
    lireReglagesVisuels(),
    depenseVisuelsDuMois("image").catch(sansBloquer("visuels.depense-images", 0)),
    depenseVisuelsDuMois("video").catch(sansBloquer("visuels.depense-videos", 0)),
  ]);
  // Le modèle vidéo est-il encore servi ? Dit à l'écran (sans rien dépenser) : mesuré le 31/10/2026, il ne l'est plus.
  const servi = await etatModeleVideo(reglages.modeleVideo);
  return { reglages, depenseImagesUsd, depenseVideosUsd, videoIndisponible: servi.servi ? null : servi.raison };
}

export type IssueVisuel = { ok: true; vue: VueVisuel; bloc: WorkspaceBlock; note?: string } | { ok: false; raison: string };

const NATURE_BLOC: Record<NatureVisuel, "image" | "video" | "video-donnees"> = { IMAGE: "image", VIDEO: "video", VIDEO_DONNEES: "video-donnees" };

/** Le bloc de la réponse — l'état du visuel, et la route que la carte relit. */
export function blocDuVisuel(v: VueVisuel): WorkspaceBlock {
  return {
    kind: "visuel", title: v.titre, nature: NATURE_BLOC[v.nature], visuelId: v.id, etat: v.etat, etatHref: routeVisuel(v.id),
    src: v.src, telecharger: v.telecharger, drive: v.drive, detail: v.detail, erreur: v.erreur, progression: v.progression,
  };
}

const vueDe = (v: AssistantIaVisuel) => vueVisuel(v);

/** Les portes communes : interrupteur de la nature, interrupteur général, plafond du mois. `null` = on peut. */
async function portes(nature: NatureVisuel, r: ReglagesVisuels): Promise<string | null> {
  const active = nature === "IMAGE" ? r.imagesActives : nature === "VIDEO" ? r.videosActives : r.donneesActives;
  if (!active) return refusCoupe(nature);
  const coupee = await refusSiIaCoupee();
  if (coupee) return coupee;
  if (nature === "VIDEO_DONNEES") return null;
  const route = nature === "IMAGE" ? "image" : "video";
  const plafond = nature === "IMAGE" ? r.imagesPlafondUsd : r.videosPlafondUsd;
  const depense = await depenseVisuelsDuMois(route);
  return depense >= plafond ? refusPlafond(nature, plafond, depense) : null;
}

const MIMES_IMAGE = new Set(["image/png", "image/jpeg", "image/webp"]);
const RE_ID = /^[a-z0-9]{20,32}$/i;

/** Une image source (pièce jointe ou fichier du Drive), droits relus : par identifiant, sinon par nom. */
async function imageSource(user: CurrentUser, ref: string): Promise<ImageSource | { erreur: string }> {
  const r = ref.trim().replace(/^«\s*|\s*»$/g, "");
  let id = RE_ID.test(r) ? r : null;
  if (!id) {
    const hit = await resolveDriveFile(user, r);
    if ("error" in hit) return { erreur: hit.error };
    id = hit.id;
  }
  const f = await driveNodeToFile(user, id);
  if ("error" in f) return { erreur: f.error };
  if (!MIMES_IMAGE.has(f.type)) return { erreur: `« ${f.name} » n'est pas une image PNG, JPEG ou WebP : je ne peux pas la modifier.` };
  if (f.size > 20 * 1024 * 1024) return { erreur: `« ${f.name} » dépasse 20 Mo.` };
  return { octets: Buffer.from(await f.arrayBuffer()), mime: f.type, nom: f.name };
}

let logoAdventum: ImageSource | null | undefined;
async function logo(): Promise<ImageSource | null> {
  if (logoAdventum !== undefined) return logoAdventum;
  logoAdventum = await readFile(join(process.cwd(), "public/adventum-ia/logo-complet.png"))
    .then((octets) => ({ octets, mime: "image/png", nom: "logo-adventum.png" }))
    .catch(sansBloquer("visuels.logo", null));
  return logoAdventum;
}

export const FORMATS_IMAGE = { carre: "1024x1024", portrait: "1024x1536", paysage: "1536x1024" } as const;
export type FormatImage = keyof typeof FORMATS_IMAGE;

/**
 * GÉNÉRER (ou MODIFIER, avec `sources`) UNE IMAGE — synchrone : 10 à 30 s, le temps d'un tour. Le secours Gemini n'est
 * pris que si OpenAI échoue ou refuse ; la réponse le dit (`note`).
 */
export async function genererImage(user: CurrentUser, d: {
  titre: string; consigne: unknown; charte: boolean; logo: boolean; format: FormatImage; qualite: "medium" | "high"; sources: string[];
}): Promise<IssueVisuel> {
  const r = await lireReglagesVisuels();
  const refus = await portes("IMAGE", r);
  if (refus) return { ok: false, raison: refus };
  const c = filtrerConsigne(d.consigne);
  if (!c.ok) return { ok: false, raison: c.raison };
  const sources: ImageSource[] = [];
  for (const ref of d.sources.slice(0, 4)) {
    const s = await imageSource(user, ref);
    if ("erreur" in s) return { ok: false, raison: s.erreur };
    sources.push(s);
  }
  let consigne = consigneAvecCharte(c.texte, d.charte);
  if (d.logo) {
    const l = await logo();
    if (l) {
      sources.push(l);
      consigne += "\n\nLa DERNIÈRE image fournie est le logo officiel d'Adventum Pharma : place-le discrètement (coin bas droit), sans le déformer, le recolorer ni le réécrire.";
    }
  }
  const conversation = porteurCourant()?.conversation ?? null;
  const debut = Date.now();
  let issue = await imageOpenAI({ modele: r.modeleImage, consigne, taille: FORMATS_IMAGE[d.format], qualite: d.qualite, sources });
  let note: string | undefined;
  if (!issue.ok) {
    await journaliserVisuel({ userId: user.id, conversation, route: "image", provider: "openai", model: r.modeleImage, ok: false, ms: Date.now() - debut, costUsd: 0, entree: 0, sortie: 0, erreur: issue.raison });
    const { raison: raisonOpenAI, refusContenu } = issue;
    issue = await imageGemini({ modele: MODELE_IMAGE_SECOURS, consigne, sources });
    if (!issue.ok) return { ok: false, raison: `L'image n'a pas pu être générée (OpenAI : ${raisonOpenAI} ; secours Gemini : ${issue.raison}).` };
    note = `OpenAI a ${refusContenu ? "refusé" : "échoué"} (${raisonOpenAI}) : l'image vient du secours, ${MODELE_IMAGE_SECOURS}.`;
  }
  const img = issue.image;
  const cout = coutImageUsd(img.usage, img.fournisseur);
  const ms = Date.now() - debut;
  await journaliserVisuel({
    userId: user.id, conversation, route: "image", provider: img.fournisseur, model: img.modele, ok: true, ms, costUsd: cout,
    entree: img.usage.texteEntree + img.usage.imageEntree, sortie: img.usage.imageSortie,
  });
  const ligne = await prisma.assistantIaVisuel.create({
    data: {
      userId: user.id, conversationId: conversation, nature: "IMAGE", statut: "EN_COURS", titre: d.titre, consigne: c.texte,
      spec: { charte: d.charte, logo: d.logo, format: d.format, qualite: d.qualite, sources: sources.length - (d.logo ? 1 : 0), usage: { ...img.usage } } as Prisma.InputJsonValue,
      fournisseur: img.fournisseur, modele: img.modele, coutUsd: cout, secondes: Math.round(ms / 100) / 10, mime: img.mime, octets: img.octets.length,
    },
  });
  const ext = img.mime === "image/jpeg" ? "jpg" : img.mime === "image/webp" ? "webp" : "png";
  const { nodeId } = await portsArtefact.documents.creerFichier(user.id, { nom: nomDeFichierVisuel(d.titre, ligne.id, ext), octets: img.octets, mime: img.mime, dossier: DOSSIER_VISUELS });
  const fini = await prisma.assistantIaVisuel.update({ where: { id: ligne.id }, data: { statut: "PRET", driveNodeId: nodeId, progression: 100, termineLe: new Date() } });
  const vue = vueDe(fini);
  return { ok: true, vue, bloc: blocDuVisuel(vue), note };
}

/**
 * LANCER UNE VIDÉO (modèle vidéo) — en ARRIÈRE-PLAN. Avant tout : le modèle est-il encore servi ? (mesuré le 31/10/2026 :
 * non, Sora est arrêté chez le fournisseur). Rien n'est dépensé ni écrit tant que le travail n'est pas accepté.
 */
export async function lancerVideoModele(user: CurrentUser, d: { titre: string; consigne: unknown; secondes: unknown; format: "paysage" | "portrait" }): Promise<IssueVisuel> {
  const r = await lireReglagesVisuels();
  const refus = await portes("VIDEO", r);
  if (refus) return { ok: false, raison: refus };
  const c = filtrerConsigne(d.consigne);
  if (!c.ok) return { ok: false, raison: c.raison };
  const servi = await etatModeleVideo(r.modeleVideo);
  if (!servi.servi) {
    return { ok: false, raison: `La vidéo générée par un modèle n'est pas disponible : ${servi.raison}. Rien n'a été lancé ni facturé. Je peux faire, à la place, une vidéo de DONNÉES (graphique animé des chiffres de l'ERP) ou une image.` };
  }
  const secondes = dureeVideo(d.secondes, r.videoSecondesMax);
  const lance = await lancerVideo({ modele: r.modeleVideo, consigne: c.texte, secondes, taille: d.format === "portrait" ? "720x1280" : "1280x720" });
  const conversation = porteurCourant()?.conversation ?? null;
  if (!lance.ok) {
    await journaliserVisuel({ userId: user.id, conversation, route: "video", provider: "openai", model: r.modeleVideo, ok: false, ms: 0, costUsd: 0, entree: 0, sortie: 0, erreur: lance.raison });
    return { ok: false, raison: `Le fournisseur n'a pas accepté la vidéo : ${lance.raison}.` };
  }
  const ligne = await prisma.assistantIaVisuel.create({
    data: {
      userId: user.id, conversationId: conversation, nature: "VIDEO", statut: "EN_COURS", titre: d.titre, consigne: c.texte,
      spec: { secondes, format: d.format } as Prisma.InputJsonValue, fournisseur: "openai", modele: r.modeleVideo, travailExterne: lance.id, secondes,
    },
  });
  const vue = vueDe(ligne);
  return { ok: true, vue, bloc: blocDuVisuel(vue) };
}

/**
 * DEMANDER UNE VIDÉO DE DONNÉES — la spécification est déjà VÉRIFIÉE (chaque valeur lue par un outil du tour). Mise en
 * file ; rendue tout de suite ICI si ffmpeg est là, sinon par le worker au battement suivant.
 */
export async function demanderVideoDonnees(user: CurrentUser, spec: SpecVideoDonnees): Promise<IssueVisuel> {
  const r = await lireReglagesVisuels();
  const refus = await portes("VIDEO_DONNEES", r);
  if (refus) return { ok: false, raison: refus };
  const ligne = await prisma.assistantIaVisuel.create({
    data: {
      userId: user.id, conversationId: porteurCourant()?.conversation ?? null, nature: "VIDEO_DONNEES", statut: "EN_FILE", titre: spec.titre,
      spec: spec as unknown as Prisma.InputJsonValue, fournisseur: "serveur", modele: null, coutUsd: 0,
    },
  });
  // Pas d'attente : le tour répond, la vidéo se rend à côté (et la tâche de fond la reprend si ce processus s'arrête).
  if (await rendrePossible()) void rendreUneVideoDonnees(ligne.id).catch(sansBloquer("visuels.rendu-immediat"));
  const vue = vueDe(ligne);
  return { ok: true, vue, bloc: blocDuVisuel(vue) };
}

const lienConversation = (v: { conversationId: string | null }) => (v.conversationId ? `/assistant?c=${v.conversationId}` : "/assistant");

async function prevenir(v: AssistantIaVisuel, ok: boolean, raison?: string): Promise<void> {
  const quoi = v.nature === "VIDEO_DONNEES" ? "Votre vidéo de données" : v.nature === "VIDEO" ? "Votre vidéo" : "Votre image";
  await avertirPersonne(v.userId, {
    title: ok ? `${quoi} est prête — « ${v.titre.slice(0, 60)} »` : `${quoi} n'a pas abouti — « ${v.titre.slice(0, 60)} »`,
    body: ok ? "Elle est dans la conversation et dans votre Drive (« Visuels de l'assistant »)." : (raison ?? "La génération a échoué.").slice(0, 280),
    link: lienConversation(v),
  });
  await prisma.assistantIaVisuel.update({ where: { id: v.id }, data: { notifie: true } }).catch(sansBloquer("visuels.notifie"));
}

/** Rendre UNE vidéo de données — prise par un seul processus (passage EN_FILE → EN_COURS atomique). */
export async function rendreUneVideoDonnees(id: string): Promise<boolean> {
  const pris = await prisma.assistantIaVisuel.updateMany({ where: { id, statut: "EN_FILE", nature: "VIDEO_DONNEES" }, data: { statut: "EN_COURS", progression: 1 } });
  if (pris.count === 0) return false;
  const v = await prisma.assistantIaVisuel.findUniqueOrThrow({ where: { id } });
  try {
    const { octets, secondes } = await rendreVideoDonnees(v.spec as unknown as SpecVideoDonnees, async (p) => {
      await prisma.assistantIaVisuel.update({ where: { id }, data: { progression: p } }).catch(sansBloquer("visuels.progression"));
    });
    const { nodeId } = await portsArtefact.documents.creerFichier(v.userId, { nom: nomDeFichierVisuel(v.titre, v.id, "mp4"), octets, mime: "video/mp4", dossier: DOSSIER_VISUELS });
    const fini = await prisma.assistantIaVisuel.update({
      where: { id }, data: { statut: "PRET", driveNodeId: nodeId, mime: "video/mp4", octets: octets.length, secondes, progression: 100, termineLe: new Date() },
    });
    await prevenir(fini, true);
  } catch (e) {
    const raison = `Le rendu de la vidéo a échoué : ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`;
    const ko = await prisma.assistantIaVisuel.update({ where: { id }, data: { statut: "ECHEC", erreur: raison, termineLe: new Date() } });
    await prevenir(ko, false, raison);
  }
  return true;
}

/** Suivre UNE vidéo du modèle : en cours (progression), prête (déposée, coût réel, avis), échouée (dite, avis). */
async function suivreUneVideo(v: AssistantIaVisuel): Promise<void> {
  if (!v.travailExterne) return;
  const e = await suivreVideo(v.travailExterne);
  if (e.etat === "en-cours") {
    if (e.progression >= 0 && e.progression !== v.progression) await prisma.assistantIaVisuel.update({ where: { id: v.id }, data: { progression: e.progression } });
    return;
  }
  if (e.etat === "echec") {
    const ko = await prisma.assistantIaVisuel.update({ where: { id: v.id }, data: { statut: "ECHEC", erreur: `Le fournisseur a échoué : ${e.raison}`, termineLe: new Date() } });
    await journaliserVisuel({ userId: v.userId, conversation: v.conversationId, route: "video", provider: "openai", model: v.modele ?? "?", ok: false, ms: Date.now() - v.createdAt.getTime(), costUsd: 0, entree: 0, sortie: 0, erreur: e.raison });
    await prevenir(ko, false, e.raison);
    return;
  }
  const octets = await telechargerVideo(v.travailExterne);
  if (!octets) return; // relu au battement suivant
  const secondes = v.secondes ?? 0;
  const cout = coutVideoUsd(v.modele ?? "", secondes);
  const { nodeId } = await portsArtefact.documents.creerFichier(v.userId, { nom: nomDeFichierVisuel(v.titre, v.id, "mp4"), octets, mime: "video/mp4", dossier: DOSSIER_VISUELS });
  await journaliserVisuel({ userId: v.userId, conversation: v.conversationId, route: "video", provider: "openai", model: v.modele ?? "?", ok: true, ms: Date.now() - v.createdAt.getTime(), costUsd: cout, entree: 0, sortie: Math.round(secondes) });
  const fini = await prisma.assistantIaVisuel.update({
    where: { id: v.id }, data: { statut: "PRET", driveNodeId: nodeId, mime: "video/mp4", octets: octets.length, coutUsd: cout, progression: 100, termineLe: new Date() },
  });
  await prevenir(fini, true);
}

const EXPIRATION_FILE_MS = 20 * 60_000;
const BLOQUE_MS = 10 * 60_000;

/**
 * LA TÂCHE DE FOND `assistant.visuels` — chaque battement : les vidéos du modèle suivies, les vidéos de données en file
 * rendues (là où ffmpeg est), les rendus interrompus et les files abandonnées dits en ÉCHEC (jamais laissés « en cours »
 * pour toujours). `ffmpegIci` : ce processus peut rendre (le worker ; le web en local).
 */
export async function traiterVisuelsEnFile(o: { maintenant?: Date } = {}): Promise<{ suivies: number; rendues: number; expirees: number }> {
  const maintenant = o.maintenant ?? new Date();
  const out = { suivies: 0, rendues: 0, expirees: 0 };
  for (const v of await prisma.assistantIaVisuel.findMany({ where: { nature: "VIDEO", statut: "EN_COURS" }, orderBy: { createdAt: "asc" }, take: 10 })) {
    await suivreUneVideo(v).catch(sansBloquer("visuels.suivre"));
    out.suivies += 1;
  }
  // Un rendu interrompu (processus tué) : dit, et prévenu.
  for (const v of await prisma.assistantIaVisuel.findMany({ where: { nature: "VIDEO_DONNEES", statut: "EN_COURS", updatedAt: { lt: new Date(maintenant.getTime() - BLOQUE_MS) } }, take: 10 })) {
    const ko = await prisma.assistantIaVisuel.update({ where: { id: v.id }, data: { statut: "ECHEC", erreur: "Le rendu a été interrompu (redémarrage du serveur). Redemandez la vidéo.", termineLe: maintenant } });
    await prevenir(ko, false, ko.erreur ?? undefined);
    out.expirees += 1;
  }
  const ici = await rendrePossible();
  const enFile = await prisma.assistantIaVisuel.findMany({ where: { nature: "VIDEO_DONNEES", statut: "EN_FILE" }, orderBy: { createdAt: "asc" }, take: 3, select: { id: true, createdAt: true } });
  for (const v of enFile) {
    if (ici) { if (await rendreUneVideoDonnees(v.id)) out.rendues += 1; continue; }
    if (maintenant.getTime() - v.createdAt.getTime() > EXPIRATION_FILE_MS) {
      const ko = await prisma.assistantIaVisuel.update({ where: { id: v.id }, data: { statut: "ECHEC", erreur: "Aucun processus capable de rendre la vidéo (ffmpeg, sur le worker) ne l'a prise : le worker est-il arrêté ?", termineLe: maintenant } });
      await prevenir(ko, false, ko.erreur ?? undefined);
      out.expirees += 1;
    }
  }
  return out;
}

/** L'état d'un visuel — pour SA propriétaire seulement (la carte le relit). */
export async function etatVisuel(userId: string, id: string): Promise<VueVisuel | null> {
  const v = await prisma.assistantIaVisuel.findFirst({ where: { id, userId } });
  return v ? vueDe(v) : null;
}

/** Ce que la route du média sert : le fichier au Drive d'un visuel PRÊT de cette personne. */
export async function fichierDuVisuel(userId: string, id: string): Promise<{ driveNodeId: string; blobId: string; mime: string; nom: string } | null> {
  const v = await prisma.assistantIaVisuel.findFirst({ where: { id, userId, statut: "PRET" }, select: { driveNodeId: true, mime: true, titre: true, nature: true } });
  if (!v?.driveNodeId) return null;
  // La DERNIÈRE version du fichier au Drive : une retouche faite au Drive est celle qu'on sert.
  const version = await prisma.fileVersion.findFirst({ where: { nodeId: v.driveNodeId }, orderBy: { version: "desc" }, select: { blobId: true } });
  if (!version) return null;
  const ext = v.mime === "video/mp4" ? "mp4" : v.mime === "image/jpeg" ? "jpg" : v.mime === "image/webp" ? "webp" : "png";
  return { driveNodeId: v.driveNodeId, blobId: version.blobId, mime: v.mime ?? "application/octet-stream", nom: nomDeFichierVisuel(v.titre, id, ext) };
}
