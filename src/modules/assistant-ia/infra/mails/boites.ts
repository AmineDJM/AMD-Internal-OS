import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { boiteGmailAdam } from "../operations/envoi-gmail";
import { registreDesCapacites } from "../capacites";
import type { PropositionCarte } from "../operations";
import { preparerMails, SCHEMA_MAILS } from "../operations/envoi-gmail";
import { charteDuMail, signatureDe } from "./redaction";
import { rendreMailHtml, rendreMailTexte } from "../../domaine/mails/gabarit";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MAILS DE BOUT EN BOUT (lot P1, décision 0047) — « Tu as accès à ton Gmail ? » se répond en LISANT l'état des
 * connexions, et « envoie-leur » part par UNE boîte nommée, après la carte « Envoyer ».
 *
 * Direction, 02/11 : « quand je parle de boîte mail, je parle de celle d'ADAM ». La boîte de l'assistant est le GMAIL
 * D'ADAM (l'unique connexion Google, GOOGLE_ADAM_EMAIL), par la machine à états de son écran (opération `envoyer_gmail`,
 * `lib/google/gmail/envoi.ts`), pour la Direction et le Super Admin. Elle ne peut pas envoyer : on le DIT, sans se
 * rabattre en silence sur une autre boîte. La boîte MICROSOFT de la personne (`microsoft-mail-actions:sendMessage`,
 * `saveDraft`) ou sa boîte SMTP (`mail-actions:sendMailAction`) servent SEULEMENT si elle le demande (`boite`).
 *
 * Toutes passent par la fenêtre d'annulation (R3 réversible : le bouton suffit, plus de ressaisie). Un BROUILLON
 * seulement si la personne le demande.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type Boite = "gmail_adam" | "microsoft" | "smtp" | "erp";
const EXEC = (u: CurrentUser) => u.role === "SUPER_ADMIN" || u.role === "DIRECTION";

export interface EtatBoites {
  gmailAdam: { reliee: boolean; adresse: string | null; envoi: boolean; raison: string | null; ouvertePourToi: boolean };
  microsoft: { reliee: boolean; adresse: string | null; etat: string | null };
  smtp: { reliee: boolean; adresse: string | null };
  /** La boîte qui enverra par défaut (null : aucune). */
  parDefaut: Boite | null;
}

/** L'ÉTAT DES BOÎTES — lu en base, sans jeton. */
export async function etatDesBoites(user: CurrentUser): Promise<EtatBoites> {
  const [g, ms, smtp] = await Promise.all([
    boiteGmailAdam(),
    prisma.mailConnection.findUnique({ where: { userId: user.id }, select: { address: true, status: true } }),
    prisma.mailAccount.findUnique({ where: { userId: user.id }, select: { email: true } }),
  ]);
  const gmailAdam = { reliee: !!g, adresse: g?.address ?? null, envoi: !!g?.envoi, raison: g?.raison ?? null, ouvertePourToi: EXEC(user) };
  const microsoft = { reliee: !!ms && ms.status === "connected", adresse: ms?.address ?? null, etat: ms?.status ?? null };
  // La Direction (et le Super Admin) écrit par la boîte d'ADAM — jamais un repli silencieux sur une autre boîte. Les autres
  // (assistante, KAM, réglementaire…) n'écrivent pas au nom d'Adam : par LEUR boîte (Microsoft, puis SMTP), sinon par
  // l'envoi de l'ERP (mesuré par le banc d'audit Q1 : sans cela, le mail restait du texte dans la réponse).
  const parDefaut: Boite | null = gmailAdam.ouvertePourToi
    ? (gmailAdam.envoi ? "gmail_adam" : null)
    : microsoft.reliee ? "microsoft" : smtp ? "smtp" : "erp";
  return { gmailAdam, microsoft, smtp: { reliee: !!smtp, adresse: smtp?.email ?? null }, parDefaut };
}

const CAPACITE: Record<"microsoft" | "brouillon" | "smtp" | "erp", string> = {
  microsoft: "microsoft-mail-actions:sendMessage",
  brouillon: "microsoft-mail-actions:saveDraft",
  smtp: "mail-actions:sendMailAction",
  erp: "smart-mail-actions:sendMail",
};
const nomDeCapacite = (id: string): string | undefined => registreDesCapacites().capacites.find((c) => c.id === id)?.outil;
const json = (o: unknown) => JSON.stringify(o);

/**
 * LES OUTILS — `trouver` rend un outil du tour par son nom (les capacités et l'opération Gmail y sont déjà, avec leurs
 * gardes) ; `propositions` est la carte du tour : la carte d'envoi y est renommée « Envoyer par … ».
 */
export function outilsMails(user: CurrentUser, trouver: (nom: string) => PowerTool | undefined, propositions: PropositionCarte[]): PowerTool[] {
  const ouvert = (u: CurrentUser) => u.id === user.id;
  return [
    {
      def: {
        name: "mes_boites_mail",
        description: "LIS les boîtes mail reliées : le Gmail d'Adam (l'unique compte Google de la plateforme), la boîte Microsoft et la boîte SMTP de la personne — reliée ou non, adresse, si l'envoi est possible et laquelle enverra. Pour répondre à « as-tu accès à mon/ton Gmail ? ». Aucun jeton n'est lu.",
        input_schema: { type: "object", properties: {} },
      },
      allowed: ouvert,
      label: "Boîtes mail lues",
      run: async () => {
        const e = await etatDesBoites(user);
        return json({
          ...e,
          consigne: e.parDefaut
            ? `Réponds avec cet état, tel quel. Un envoi partira par ${e.parDefaut === "gmail_adam" ? `le Gmail d'Adam (${e.gmailAdam.adresse})` : e.parDefaut === "microsoft" ? `la boîte Microsoft (${e.microsoft.adresse})` : e.parDefaut === "smtp" ? `la boîte SMTP (${e.smtp.adresse})` : "l'envoi de l'ERP"} après la carte « Envoyer ».`
            : `La boîte Gmail d'Adam ne peut pas envoyer (${e.gmailAdam.reliee ? e.gmailAdam.raison : "non reliée"}) : dis-le, et où la relier (Chief of Staff › Réglages › « Connecter Google »). Ne te rabats sur une autre boîte que si la personne le demande.`,
        });
      },
    },
    {
      def: {
        name: "envoyer_mail",
        description: "ENVOIE des mails après confirmation, sans poser de questions : UNE carte « Envoyer » pour tous (aperçu réel de chaque mail), par la boîte Gmail d'ADAM (Direction, Super Admin), annulable pendant la fenêtre d'annulation. Destinataires par leurs NOMS (l'annuaire les résout) ; objet, ton, signature : choisis-les. Rédige un CONTENU STRUCTURÉ (salutation personnalisée, paragraphes courts, liste à puces ou TABLEAU pour un planning, **échéances en gras**, clôture) — jamais du HTML : le gabarit le met en page. Un mail par personne quand le contenu lui est propre. La Direction et le Super Admin écrivent par la boîte d'Adam (Microsoft ou SMTP seulement s'ils le demandent, `boite`) ; les autres personnes par LEUR boîte (Microsoft, sinon SMTP), sinon par l'envoi de l'ERP — même carte, même gabarit. `brouillon: true` SEULEMENT sur demande.",
        input_schema: {
          type: "object",
          properties: {
            mails: SCHEMA_MAILS,
            societe: { type: "string", description: "La société d'envoi (charte) si la demande la nomme ; sinon celle de la personne." },
            boite: { type: "string", enum: ["gmail_adam", "microsoft", "smtp", "erp"], description: "Seulement si la personne demande EXPLICITEMENT sa propre boîte (microsoft, smtp) ; sinon le Gmail d'Adam." },
            brouillon: { type: "boolean", description: "Un brouillon au lieu d'un envoi — seulement sur demande." },
          },
          required: ["mails"],
        },
      },
      allowed: ouvert,
      label: "Mail préparé",
      run: async (e) => {
        const etat = await etatDesBoites(user);
        const voulue = typeof e.boite === "string" ? (e.boite as Boite) : null;
        const brouillon = e.brouillon === true;
        const dispo = (b: Boite) => (b === "gmail_adam" ? etat.gmailAdam.envoi && etat.gmailAdam.ouvertePourToi : b === "microsoft" ? etat.microsoft.reliee : b === "smtp" ? etat.smtp.reliee : true);
        const boite: Boite | null = voulue ? (dispo(voulue) ? voulue : null) : etat.parDefaut;
        if (!boite) {
          const raison = voulue ? `La boîte demandée (${voulue}) ne peut pas envoyer.`
            : !etat.gmailAdam.ouvertePourToi ? "Faire écrire par la boîte d'Adam est réservé à la Direction et au Super Admin."
              : `La boîte Gmail d'Adam ne peut pas envoyer : ${etat.gmailAdam.reliee ? etat.gmailAdam.raison : "elle n'est pas reliée (Chief of Staff › Réglages › « Connecter Google »)"}.`;
          return json({ statut: "REFUS", raison, etat, consigne: "Dis-le tel quel ; rien n'est préparé. Ne propose une autre boîte (Microsoft, SMTP de la personne) que si elle te le demande." });
        }
        if (brouillon && (boite === "smtp" || boite === "erp")) return json({ statut: "REFUS", raison: "Cette boîte ne garde pas de brouillon : Gmail d'Adam ou boîte Microsoft." });
        const nom = boite === "gmail_adam" ? "envoyer_gmail" : nomDeCapacite(CAPACITE[brouillon ? "brouillon" : boite]);
        const outil = nom ? trouver(nom) : undefined;
        if (!outil || !outil.allowed(user)) return json({ statut: "REFUS", raison: `L'envoi par cette boîte n'est pas ouvert à ton rôle (${boite}).` });
        let entree: Record<string, unknown>;
        if (boite === "gmail_adam") entree = { mails: e.mails, ...(typeof e.societe === "string" ? { societe: e.societe } : {}), ...(brouillon ? { brouillon: true } : {}) };
        else {
          // La boîte de la personne (sur sa demande) : un mail par carte, le MÊME gabarit.
          const prep = await preparerMails(Array.isArray(e.mails) ? e.mails.slice(0, 1) : []);
          if (!("ok" in prep)) return json({ statut: "INCOMPLET", manque: prep.manque, consigne: "Pose UNE seule question : la première de `manque`." });
          const m = prep.mails[0]!;
          const signature = await signatureDe(user);
          const charte = await charteDuMail(user, typeof e.societe === "string" ? e.societe : null, signature);
          const to = m.destinataires.map((d) => d.email).join(", "), cc = m.cc.map((d) => d.email).join(", ");
          entree = boite === "microsoft"
            ? { to, ...(cc ? { cc } : {}), subject: m.objet, bodyHtml: rendreMailHtml(m.contenu, signature, charte, m.objet) }
            : { to, ...(cc ? { cc } : {}), subject: m.objet, body: rendreMailTexte(m.contenu, signature, charte) };
          // Une boîte de la personne : un mail par carte — le second se prépare au tour suivant (une carte par tour).
        }
        const avant = propositions.length;
        const sortie = await outil.run(entree, user);
        const adresse = boite === "gmail_adam" ? etat.gmailAdam.adresse : boite === "microsoft" ? etat.microsoft.adresse : etat.smtp.adresse;
        const dite = boite === "gmail_adam" ? `le Gmail d'Adam (${adresse})` : boite === "microsoft" ? `ta boîte Microsoft (${adresse})` : boite === "smtp" ? `ta boîte SMTP de l'ERP (${adresse})` : "l'envoi de l'ERP";
        if (propositions.length > avant && boite !== "gmail_adam") {
          const p = propositions[propositions.length - 1]!;
          p.proposition.title = brouillon ? `Brouillon dans ${dite}` : `Envoyer par ${dite}`;
          p.proposition.libelleBouton = brouillon ? "Enregistrer le brouillon" : "Envoyer";
          await prisma.assistantActionIntent.update({ where: { id: p.intentId }, data: { title: p.proposition.title } }).catch(sansBloquer("mails.envoyer.titre-carte"));
        }
        let lu: Record<string, unknown> = {};
        try { lu = JSON.parse(sortie) as Record<string, unknown>; } catch { lu = { sortie }; }
        return json({ ...lu, boite: dite, consigne: `Dis en une phrase que la carte « ${brouillon ? "Enregistrer le brouillon" : "Envoyer"} » attend sa confirmation et que le mail partira par ${dite}${brouillon ? "" : " — annulable pendant la fenêtre d'annulation (2 min par défaut)"}. Ne dis jamais qu'il est parti.` });
      },
    },
  ];
}
