/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PORTE D'ATTENTION — le seul endroit d'où une mission parle au dirigeant.
 *
 * Elle reçoit un SIGNAL typé du runtime (conclusion, blocage, accord, question, attente échue),
 * lui donne un niveau par la politique (`attention/policy.ts`), refuse de redire ce qui a déjà
 * été dit (clé + cadence, relues dans le journal canonique de la mission — pas de table de plus),
 * rétrograde en JOURNAL au-delà du plafond quotidien, compose le message exécutif, et livre :
 * la notification interne (toujours à partir de JOURNAL), le push (INFO et au-delà), l'e-mail
 * (ATTENTION et au-delà — depuis la boîte que la personne a connectée, vers sa propre adresse ;
 * sans boîte, le journal DIT que l'e-mail n'est pas parti).
 *
 * L'OMNICANAL (mandat 5 §37) : la table du niveau est corrigée par ce que la personne a ENSEIGNÉ
 * (clé `canalPrefere` : e-mail, ERP seul, Slack, Teams, WhatsApp, SMS ; clé `heuresSilence`), par
 * ce qui est réellement BRANCHÉ (les connecteurs de messagerie configurés et ouverts à elle,
 * §36), et par la CONFIDENTIALITÉ (un signal marqué tel, ou une mission qui touche à une capacité
 * HR_SENSITIVE : rien de son contenu ne sort de l'ERP, les canaux externes portent un corps
 * neutre). Le connecteur est appelé par le runtime des skills — le même outil que la
 * conversation, sous les mêmes droits ; la porte ne connaît ni Slack ni Twilio.
 *
 * Tout ce qui est envoyé est inscrit au journal (`NOTIFIED`, avec niveau, clé et canaux) : le
 * dirigeant peut relire pourquoi il a été dérangé — et par où —, et un banc peut compter.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { notifyUser } from "@/lib/notify";
import { lireAdressesDeContact } from "@/lib/personnes/joignabilite";
// LE MÊME transport que les rappels — en écrire un second donnerait deux façons d'envoyer un
// e-mail au dirigeant, qui divergeraient (§118.5).
import { envoyerParBoiteConnectee, type IssueEnvoi } from "@/platform/in-process/courrier/proprietaire";
import { journaliser } from "@/lib/missions/runtime/store";
import { capabilityMeta } from "@/lib/missions/registry/capability-meta";
import {
  cadenceMs, canauxPour, classer, cleDe, composerMessage, corpsNeutrePour, lireCanal, lireHeuresSilence, PLAFOND_QUOTIDIEN,
  type HeuresSilence, type PreferencesCanaux,
} from "@/lib/missions/attention/policy";
import type { NiveauSignal, PorteAttention, SignalAttention } from "@/lib/missions/ports";
import { reglesEnVigueurPour } from "@/platform/ia/teach/store";
import { connecteursMessagerie, executerOutilDynamique } from "@/platform/in-process/skills";
import { outilDeCanal, type CanalMessagerie } from "@/lib/skills/plugins";
import { proprietaire } from "@/platform/ia/proprietaire";
import { sansBloquer } from "@/lib/journal";

export type { IssueEnvoi };
export type IssueConnecteur = "envoye" | "echec" | "non-configure" | "sans-destinataire";

/** Ce que la porte a appris de la personne : son canal, sa destination sur ce canal, ses heures de silence, ses connecteurs. */
export interface PreferencesPersonne extends PreferencesCanaux {
  destinataire: string | null;
  /**
   * OÙ JOINDRE LA PERSONNE PAR E-MAIL — les adresses qu'ELLE a déclarées, dans l'ordre.
   * Vide quand elle n'en a déclaré aucune : l'envoi retombe alors sur la boîte connectée.
   */
  adressesDeContact: string[];
  /** Les règles qui ont parlé — pour le journal : « pourquoi Slack ? parce que la règle X ». */
  regles: string[];
}

export interface DependancesAttention {
  /** L'envoi d'e-mail, injectable : les tests ne montent pas de SMTP. Défaut : la boîte connectée de la personne. */
  envoyerMail?: (ownerId: string, sujet: string, corps: string, adresses: readonly string[]) => Promise<IssueEnvoi>;
  /** L'envoi par connecteur (Slack, Teams, WhatsApp, SMS), injectable. Défaut : le runtime des skills, sous les droits de la personne. */
  envoyerConnecteur?: (canal: CanalMessagerie, ownerId: string, texte: string, destinataire: string | null) => Promise<IssueConnecteur>;
  /** Les préférences de la personne, injectables. Défaut : ses règles enseignées + ses connecteurs branchés. */
  preferences?: (ownerId: string, maintenant: Date) => Promise<PreferencesPersonne>;
  maintenant?: () => Date;
}

/** Le fuseau dans lequel les heures de silence se lisent — la maison est à Alger. */
export const FUSEAU_ATTENTION = process.env.ATTENTION_FUSEAU?.trim() || "Africa/Algiers";

/** L'heure locale (0–23) d'un instant, dans le fuseau de la maison. */
export function heureLocale(d: Date, fuseau = FUSEAU_ATTENTION): number {
  try {
    const h = new Intl.DateTimeFormat("fr-FR", { hour: "numeric", hour12: false, timeZone: fuseau }).formatToParts(d).find((p) => p.type === "hour")?.value;
    const n = Number(h);
    return Number.isFinite(n) ? n % 24 : d.getUTCHours();
  } catch {
    return d.getUTCHours();
  }
}


/**
 * LE CONNECTEUR, par le runtime des skills : le même outil `<canal>_envoyer_message` que la
 * conversation, exécuté au nom de la personne (droits relus) — jamais un client Slack de plus.
 * La destination vient de la règle (« slack:#direction ») ou, pour WhatsApp et SMS, du téléphone
 * du profil ; sans destination, rien ne part et le journal le dit.
 */
async function envoyerParSkill(canal: CanalMessagerie, ownerId: string, texte: string, destinataire: string | null): Promise<IssueConnecteur> {
  const user = await proprietaire(ownerId);
  if (!user) return "echec";
  let dest = destinataire;
  if (!dest && (canal === "whatsapp" || canal === "sms")) {
    dest = (await prisma.user.findUnique({ where: { id: ownerId }, select: { phone: true } }).catch(sansBloquer("missions-attention.envoyerParSkill.user", null)))?.phone?.trim() || null;
  }
  if (!dest && canal !== "teams") return "sans-destinataire";
  const sortie = await executerOutilDynamique(outilDeCanal(canal), { destinataire: dest ?? "", texte, confirmer: true }, user).catch(sansBloquer("missions-attention.envoyerParSkill.executerOutilDynamique", null));
  if (!sortie) return "non-configure";
  try {
    const j = JSON.parse(sortie) as { ok?: unknown; limite?: unknown };
    if (j.ok === true) return "envoye";
    return j.limite === "RESSOURCE" ? "non-configure" : "echec";
  } catch {
    return "echec";
  }
}

/** Les préférences de la personne : ses règles enseignées (canal, silence) et ses connecteurs réellement branchés. */
export async function preferencesDe(ownerId: string, maintenant: Date): Promise<PreferencesPersonne> {
  const out: PreferencesPersonne = { canalPrefere: null, destinataire: null, adressesDeContact: [], heuresSilence: null, heure: heureLocale(maintenant), connecteurs: [], confidentiel: false, regles: [] };
  const regles = await reglesEnVigueurPour(ownerId).catch(sansBloquer("missions-attention.preferencesDe.reglesEnVigueurPour", null));
  for (const r of regles?.resolution.enVigueur ?? []) {
    const cle = r.params && typeof r.params.cle === "string" ? r.params.cle : null;
    if (cle === "canalPrefere") {
      const c = lireCanal(r.params?.valeur);
      if (c) {
        out.canalPrefere = c.canal;
        out.destinataire = c.destinataire;
        // La MÊME déclaration porte la ou les adresses : « email:a@x.dz, b@y.dz ».
        const lues = lireAdressesDeContact(r.params?.valeur);
        if (lues.length > 0) out.adressesDeContact = lues;
        out.regles.push(`canal : ${r.statement.slice(0, 120)}`);
      }
    } else if (cle === "heuresSilence") {
      const h: HeuresSilence | null = lireHeuresSilence(r.params?.valeur);
      if (h) { out.heuresSilence = h; out.regles.push(`silence : ${r.statement.slice(0, 120)}`); }
    }
  }
  if (out.canalPrefere && out.canalPrefere !== "email" && out.canalPrefere !== "notification") {
    const user = await proprietaire(ownerId);
    out.connecteurs = user ? await connecteursMessagerie(user).catch(sansBloquer("missions-attention.preferencesDe.connecteursMessagerie", [])) : [];
  }
  return out;
}

/** Une mission est CONFIDENTIELLE quand une de ses étapes touche à une capacité HR_SENSITIVE (paie, contrat, santé). */
async function missionConfidentielle(missionId: string): Promise<boolean> {
  const steps = await prisma.missionStep.findMany({ where: { missionId, capability: { not: null } }, select: { capability: true } }).catch(sansBloquer("missions-attention.missionConfidentielle.missionStep", []));
  return steps.some((s) => s.capability && capabilityMeta(s.capability).effect === "HR_SENSITIVE");
}

/** Le dernier signal de même clé, pour la cadence. Lu dans le journal, jamais en mémoire. */
async function dernierSignal(missionId: string, cle: string): Promise<Date | null> {
  const e = await prisma.missionEvent.findFirst({
    where: { missionId, kind: "NOTIFIED", detail: { path: ["cle"], equals: cle } },
    orderBy: { at: "desc" },
    select: { at: true },
  }).catch(sansBloquer("missions-attention.dernierSignal.missionEvent", null));
  return e?.at ?? null;
}

/** Les signaux INFO/ATTENTION/ARBITRAGE des dernières 24 h pour cette personne — toutes missions. */
async function signauxDuJour(ownerId: string, depuis: Date): Promise<number> {
  return prisma.missionEvent.count({
    where: {
      kind: "NOTIFIED", at: { gte: depuis },
      mission: { ownerId },
      OR: [{ detail: { path: ["niveau"], equals: "INFO" } }, { detail: { path: ["niveau"], equals: "ATTENTION" } }, { detail: { path: ["niveau"], equals: "ARBITRAGE" } }],
    },
  }).catch(sansBloquer("missions-attention.signauxDuJour.missionEvent", 0));
}

export function porteAttentionPour(deps: DependancesAttention = {}): PorteAttention {
  const envoyer = deps.envoyerMail ?? envoyerParBoiteConnectee;
  const envoyerConnecteur = deps.envoyerConnecteur ?? envoyerParSkill;
  const preferences = deps.preferences ?? preferencesDe;
  const horloge = deps.maintenant ?? (() => new Date());
  return {
    async signaler(signal: SignalAttention) {
      let niveau: NiveauSignal = classer(signal);
      const cle = cleDe(signal);
      const maintenant = horloge();
      if (niveau === "SILENCE") return { niveau, canaux: [], supprime: false };

      // ── LA CADENCE : le même fait ne se redit pas ─────────────────────────────────────
      const dernier = await dernierSignal(signal.missionId, cle);
      if (dernier && maintenant.getTime() - dernier.getTime() < cadenceMs(niveau)) {
        return { niveau, canaux: [], supprime: true };
      }
      // ── LE PLAFOND QUOTIDIEN : au-delà, on rétrograde — jamais un arbitrage ──────────
      if (niveau === "INFO" || niveau === "ATTENTION") {
        const n = await signauxDuJour(signal.ownerId, new Date(maintenant.getTime() - 24 * 3600_000));
        if (n >= PLAFOND_QUOTIDIEN) niveau = "JOURNAL";
      }
      // ── LES PRÉFÉRENCES ET LA CONFIDENTIALITÉ : ce qui corrige la table du niveau ─────
      const prefs = niveau === "JOURNAL" ? null : await preferences(signal.ownerId, maintenant).catch(sansBloquer("missions-attention.signaler.preferences", null));
      const confidentiel = signal.confidentiel ?? (niveau === "JOURNAL" ? false : await missionConfidentielle(signal.missionId));
      const canaux = canauxPour(niveau, { ...(prefs ?? {}), confidentiel });
      // Le moteur ne connaît pas le titre affiché ; le pont le relit.
      const titreMission = signal.titre
        || (await prisma.mission.findUnique({ where: { id: signal.missionId }, select: { title: true } }).catch(sansBloquer("missions-attention.signaler.mission", null)))?.title
        || "Mission";
      const { titre, corps } = composerMessage({ ...signal, titre: titreMission });
      const lien = `/missions/${signal.missionId}`;
      const corpsExterne = canaux.corpsNeutre ? corpsNeutrePour(niveau, lien) : `${corps}\n\nOuvrir la mission : ${lien}`;
      const livres: string[] = [];

      if (canaux.notification) {
        const type = signal.kind === "APPROVAL_REQUIRED" || signal.kind === "PLAN_CHANGED" || signal.kind === "QUESTION" ? "VALIDATION_REQUIRED" : "GENERIC";
        await notifyUser({
          userId: signal.ownerId, type, title: titre, body: corps, link: lien,
          // Sans push pour JOURNAL : la ligne existe au centre de notifications, l'appareil ne vibre pas.
          // `sendPushToUser` ne sait pas se taire ; un tag vide et non insistant reste le minimum.
          push: canaux.push ? { tag: `mission-${signal.missionId}-${signal.kind}`, requireInteraction: canaux.insistant } : { tag: `mission-${signal.missionId}-journal`, requireInteraction: false },
        });
        livres.push("notification");
        if (canaux.push) livres.push("push");
      }
      let email: IssueEnvoi | "non-requis" = "non-requis";
      if (canaux.email) {
        email = await envoyer(
          signal.ownerId,
          `[Adam] ${canaux.corpsNeutre ? "Une mission requiert votre attention" : titre}`,
          corpsExterne,
          prefs?.adressesDeContact ?? [],
        );
        if (email === "envoye") livres.push("email");
      }
      let connecteur: { canal: string; issue: IssueConnecteur } | null = null;
      if (canaux.connecteur) {
        const canal = canaux.connecteur as CanalMessagerie;
        const texte = canaux.corpsNeutre ? corpsExterne : `[Adam] ${titre}\n${corps}\nOuvrir : ${lien}`;
        const issue = await envoyerConnecteur(canal, signal.ownerId, texte, prefs?.destinataire ?? null).catch(sansBloquer("missions-attention.signaler.envoyerConnecteur", "echec" as const));
        connecteur = { canal, issue };
        if (issue === "envoye") livres.push(canal);
      }
      // JOURNALISÉ À L'HEURE DE LA PORTE : c'est ce journal que la cadence et le plafond relisent —
      // et c'est là que la personne relit POURQUOI tel canal (règle), pourquoi rien n'a vibré (silence),
      // pourquoi le corps était neutre (confidentiel).
      await journaliser(signal.missionId, "NOTIFIED", `${niveau} — ${titre} : ${corps}`, {
        niveau, cle, canaux: livres, email, kind: signal.kind,
        ...(prefs?.adressesDeContact.length ? { adressesDeContact: prefs.adressesDeContact } : {}),
        ...(signal.stepKey ? { stepKey: signal.stepKey } : {}),
        ...(connecteur ? { connecteur } : {}),
        ...(canaux.differe ? { differe: true, heuresSilence: prefs?.heuresSilence ?? null } : {}),
        ...(canaux.corpsNeutre ? { confidentiel: true } : {}),
        ...(canaux.canalIndisponible ? { canalIndisponible: canaux.canalIndisponible } : {}),
        ...(prefs?.regles.length ? { regles: prefs.regles } : {}),
      }, undefined, maintenant);
      return { niveau, canaux: livres, supprime: false };
    },
  };
}
