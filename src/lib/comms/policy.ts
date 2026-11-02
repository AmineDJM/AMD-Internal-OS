import { MailSendPolicy } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

/**
 * LA POLITIQUE D'ENVOI — la règle qui décide si un message peut PARTIR.
 *
 * Elle vit en base, pas dans le code : une règle de sécurité qu'on ne peut changer qu'en
 * redéployant finit par être contournée autrement (un script, une exception « juste cette
 * fois »), et c'est ainsi qu'on perd le contrôle de ce qui sort au nom de l'entreprise.
 *
 * Trois états, et un seul défaut :
 *   • `REQUIRE_APPROVAL` (défaut) — Adam prépare tout, n'envoie rien sans que le PDG ait vu
 *     l'exact contenu. C'est le seul état où aucun chemin — plan d'action, mission de fond,
 *     tâche planifiée, webhook — ne peut faire partir un message tout seul.
 *   • `AUTO_SEND` — envoi autonome. Bascule SENSIBLE : elle se confirme et s'audite.
 *   • `DRAFT_ONLY` — rien ne part, même approuvé. L'état des périodes de silence.
 *
 * Le COUPE-CIRCUIT sortant (`outboundPaused`) prime sur tout, y compris `AUTO_SEND` : c'est le
 * geste d'urgence, il doit gagner sans discussion.
 */

export const GLOBAL_SCOPE = "global";

export interface CommunicationPolicyState {
  mailSendPolicy: MailSendPolicy;
  outboundPaused: boolean;
  inboundPaused: boolean;
  updatedAt: Date | null;
  updatedById: string | null;
}

const DEFAULT_STATE: CommunicationPolicyState = {
  mailSendPolicy: MailSendPolicy.REQUIRE_APPROVAL,
  outboundPaused: false,
  inboundPaused: false,
  updatedAt: null,
  updatedById: null,
};

/**
 * L'état courant. L'ABSENCE de ligne vaut le défaut le plus SÛR (`REQUIRE_APPROVAL`) : une base
 * neuve, une migration à moitié jouée ou une ligne effacée ne doivent jamais ouvrir l'envoi.
 */
export async function getCommunicationPolicy(scope: string = GLOBAL_SCOPE): Promise<CommunicationPolicyState> {
  const row = await prisma.communicationPolicy.findUnique({ where: { scope } }).catch(sansBloquer("policy.getCommunicationPolicy.communicationPolicy", null));
  if (!row) return { ...DEFAULT_STATE };
  return {
    mailSendPolicy: row.mailSendPolicy,
    outboundPaused: row.outboundPaused,
    inboundPaused: row.inboundPaused,
    updatedAt: row.updatedAt,
    updatedById: row.updatedById,
  };
}

export async function setMailSendPolicy(policy: MailSendPolicy, actorId: string, scope: string = GLOBAL_SCOPE): Promise<void> {
  await prisma.communicationPolicy.upsert({
    where: { scope },
    create: { scope, mailSendPolicy: policy, updatedById: actorId },
    update: { mailSendPolicy: policy, updatedById: actorId },
  });
}

/** Le coupe-circuit SORTANT — prime sur `AUTO_SEND`. */
export async function setOutboundPaused(paused: boolean, actorId: string, scope: string = GLOBAL_SCOPE): Promise<void> {
  await prisma.communicationPolicy.upsert({
    where: { scope },
    create: { scope, outboundPaused: paused, updatedById: actorId },
    update: { outboundPaused: paused, updatedById: actorId },
  });
}

/** Suspend le TRAITEMENT de la boîte (l'ingestion s'arrête ; la connexion reste). */
export async function setInboundPaused(paused: boolean, actorId: string, scope: string = GLOBAL_SCOPE): Promise<void> {
  await prisma.communicationPolicy.upsert({
    where: { scope },
    create: { scope, inboundPaused: paused, updatedById: actorId },
    update: { inboundPaused: paused, updatedById: actorId },
  });
}

/** La décision, prise UNE fois et rendue explicite — jamais un booléen nu dans un appelant. */
export type SendDecision =
  | { allowed: true; reason: "auto" | "approved" }
  | { allowed: false; reason: "approval-required" | "draft-only" | "outbound-paused"; message: string };

/**
 * Ce message peut-il PARTIR maintenant ?
 *
 * `approved` dit si le PDG a validé CE contenu exact (le hash est comparé en amont, dans
 * `outbound.ts`). La fonction est PURE : elle se teste sans base, et le même raisonnement sert
 * au chat, aux missions de fond et à l'exécution d'un plan — il n'y a pas deux versions de la
 * règle qui pourraient diverger.
 */
export function decideSend(state: CommunicationPolicyState, approved: boolean): SendDecision {
  if (state.outboundPaused) {
    return {
      allowed: false,
      reason: "outbound-paused",
      message: "L'envoi de courriel est SUSPENDU (coupe-circuit). Rien ne part tant qu'il n'est pas relevé.",
    };
  }
  if (state.mailSendPolicy === MailSendPolicy.DRAFT_ONLY) {
    return {
      allowed: false,
      reason: "draft-only",
      message: "La politique est « brouillons seulement » : le message est prêt, mais rien ne part.",
    };
  }
  if (state.mailSendPolicy === MailSendPolicy.AUTO_SEND) return { allowed: true, reason: "auto" };
  if (approved) return { allowed: true, reason: "approved" };
  return {
    allowed: false,
    reason: "approval-required",
    message: "Approbation requise : ce message ne partira qu'après votre validation explicite.",
  };
}

export const POLICY_LABEL: Record<MailSendPolicy, string> = {
  REQUIRE_APPROVAL: "Approbation requise",
  AUTO_SEND: "Envoi autonome",
  DRAFT_ONLY: "Brouillons seulement",
};

export const POLICY_HELP: Record<MailSendPolicy, string> = {
  REQUIRE_APPROVAL: "Adam prépare tout (lecture, analyse, brouillons, relances) et n'envoie qu'après votre validation du contenu exact.",
  AUTO_SEND: "Adam envoie sans demander. Réservé aux périodes où vous lui faites confiance sur des échanges déjà cadrés.",
  DRAFT_ONLY: "Adam prépare, mais AUCUN message ne part — même approuvé. Utile pendant une période de silence.",
};

/**
 * « Adam, passe les mails en envoi autonome. » — la politique se règle AUSSI en langage naturel.
 *
 * Fonction PURE, volontairement stricte : on ne devine pas une bascule de sécurité à partir d'une
 * phrase ambiguë. Rien ne correspond → `null`, et l'assistant demande de préciser plutôt que de
 * choisir à la place du PDG.
 */
export function parseMailPolicyPhrase(raw: string): MailSendPolicy | null {
  const q = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!q) return null;

  // L'ordre compte : « remets l'approbation obligatoire » contient « envoi »… mais dit d'abord
  // « approbation ». On teste donc le retour à la sécurité EN PREMIER.
  if (/(approbation|validation|autorisation|accord)\b.*(obligatoire|requise|avant|systematique)|remets? (l')?approbation|redemande (mon )?accord|plus rien sans (mon )?accord|demande[ -]moi avant/.test(q)) {
    return MailSendPolicy.REQUIRE_APPROVAL;
  }
  if (/brouillon(s)? (seulement|uniquement)|que des brouillons|n'envoie plus rien|prepare sans envoyer|mode brouillon/.test(q)) {
    return MailSendPolicy.DRAFT_ONLY;
  }
  if (/envoi autonome|envoie (tout )?(seul|automatiquement|sans (me )?demander)|autonomie (d'|de l')envoi|plus besoin de (mon )?accord|tu peux envoyer sans/.test(q)) {
    return MailSendPolicy.AUTO_SEND;
  }
  return null;
}
