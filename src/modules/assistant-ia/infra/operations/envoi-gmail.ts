import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { canalAdamOuvert } from "../../domaine/mails/canal";
import { boiteGmailAdam, confirmerMailAdam, enregistrerExecuteurGmail, freinGmail, preparerMailAdam } from "@/lib/google/gmail/envoi";
import { texte, type OperationIA } from "../../domaine/operations/types";
import { BORNES_MAIL, lireDocumentMail, STYLES_BLOC, STYLES_MAIL, type DocumentMail } from "../../domaine/mails/composer";
import type { MailVu } from "../../domaine/observation/projecteurs";
import { charteDuMail, groupeDestinataires, piecesDuDrive, rendreLeMail, resoudreDestinataire, signatureDe, type Destinataire } from "../mails/redaction";

// La boîte d'Adam lue par `mes_boites_mail`, et l'exécuteur armé là où l'on annule — par cette seule porte vers Google.
export { boiteGmailAdam, enregistrerExecuteurGmail };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * DES MAILS PAR LA BOÎTE GMAIL D'ADAM (lot P1, décision 0047) — UNE carte pour un ou plusieurs mails (« envoie un mail à
 * Redouane et à Nesrine avec leur planning » → deux mails personnalisés, une confirmation).
 *
 *   • PEU DE QUESTIONS : les destinataires se résolvent par l'annuaire (`redaction.ts`) ; une question seulement si un nom
 *     est ambigu ou introuvable. Objet, ton, signature : choisis — la personne corrige sur la carte.
 *   • LE MAIL EN BLOCS (lot I1, décision 0063) : le modèle compose un document de blocs, la charte de la société est un
 *     style applicable à tout, rien ou une partie ; UN rendu (`rendreLeMail`), assaini, avec sa version texte. L'aperçu de
 *     la carte est ce rendu, et son OBSERVATION (expéditeur, destinataires, texte, nature du rendu) part au modèle.
 *   • La MACHINE d'Adam : une intention d'envoi préparée par mail (`preparerMailAdam`), approuvée au nom de qui confirme,
 *     différée dans la fenêtre d'annulation. Droits des outils Gmail d'Adam (Direction, Super Admin) ; freins anti-boucle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const MAILS_MAX = 5;

/**
 * LE MAIL EN BLOCS (lot I1, étape 5) — le contrat dit ce que chaque style PRODUIT ; le choix est celui de la demande.
 * Aucun gabarit imposé : le style « sobre » est le défaut, la charte s'applique où on la veut, le HTML libre est permis.
 */
const SCHEMA_CONTENU = {
  type: "object",
  description: "Le mail, en BLOCS dans l'ordre. `style` : « sobre » (défaut : professionnel, sans couleur ni bandeau), « charte » (aux couleurs de la société d'envoi : bandeau, tableaux, signature, pied), « texte » (texte brut, aucun HTML). Un bloc peut porter son propre `style` (« charte », « sobre », « simple » = sans aucune mise en forme) : la charte s'applique à tout, à rien ou à une partie. Bloc `html` : HTML libre, styles en ligne permis (le serveur l'assainit). **gras** permis dans un texte. La signature de la personne est ajoutée à la fin (`signature: false` l'omet).",
  properties: {
    style: { type: "string", enum: [...STYLES_MAIL] },
    blocs: {
      type: "array",
      maxItems: BORNES_MAIL.blocs,
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["paragraphe", "titre", "liste", "tableau", "bandeau", "signature", "pied", "separateur", "html"] },
          texte: { type: "string", description: "paragraphe, titre, bandeau (texte du bandeau ; défaut : la société)." },
          elements: { type: "array", items: { type: "string" }, description: "liste : les puces." },
          colonnes: { type: "array", items: { type: "string" }, description: "tableau : les en-têtes." },
          lignes: { type: "array", items: { type: "array", items: { type: "string" } }, description: "tableau : les rangées." },
          html: { type: "string", description: "html : le fragment libre." },
          style: { type: "string", enum: [...STYLES_BLOC] },
        },
        required: ["type"],
      },
    },
    signature: { type: "boolean" },
  },
  required: ["blocs"],
};

export const SCHEMA_MAILS = {
  type: "array",
  description: "Un mail par destinataire quand le contenu est personnel (son planning) ; un seul mail à plusieurs sinon.",
  items: {
    type: "object",
    properties: {
      a: { type: "string", description: "Destinataire(s) : NOMS (résolus par l'annuaire) ou adresses, séparés par des virgules." },
      cc: { type: "string" },
      objet: { type: "string", description: "Un objet clair et précis, choisi par toi." },
      contenu: SCHEMA_CONTENU,
      pieces: { type: "array", items: { type: "string" }, description: "Pièces jointes : NOMS de fichiers de TON Drive (BC, facture, attestation déjà déposés). Facultatif." },
    },
    required: ["a", "objet", "contenu"],
  },
};

interface MailPrepare {
  destinataires: Destinataire[]; cc: Destinataire[]; objet: string; document: DocumentMail; pieces: string[];
  /** F2 (TR-MU-03) : le destinataire introuvable, à compléter sur la carte (« le pharmacien responsable »). */
  aCompleter?: string;
}

/** Résoudre et lire chaque mail : au plus UNE question (la première ambiguïté ou le premier nom introuvable). */
export async function preparerMails(
  brut: unknown, corpsSimple?: { a: string; objet: string; corps: string; cc?: string },
  /** F2 : un destinataire introuvable (ou absent) n'arrête pas la carte — il reste à compléter sur elle. */
  opts: { destinataireACompleter?: boolean } = {},
): Promise<{ ok: true; mails: MailPrepare[] } | { manque: string[]; precision?: string }> {
  const liste = Array.isArray(brut) ? brut.slice(0, MAILS_MAX) : corpsSimple ? [{ a: corpsSimple.a, cc: corpsSimple.cc, objet: corpsSimple.objet, contenu: { blocs: corpsSimple.corps.split(/\n{2,}/).map((texte) => ({ type: "paragraphe", texte })) } }] : [];
  if (!liste.length) return { manque: ["le destinataire et le contenu du mail"] };
  const mails: MailPrepare[] = [];
  for (const m of liste) {
    const o = (m && typeof m === "object" ? m : {}) as Record<string, unknown>;
    let aCompleter: string | undefined;
    const resoudre = async (champ: string): Promise<Destinataire[] | { manque: string[]; precision?: string }> => {
      const out: Destinataire[] = [];
      for (const qui of texte(o, champ).split(/\s*[,;]\s*|\s+et\s+/).filter(Boolean).slice(0, 20)) {
        const groupe = await groupeDestinataires(qui);
        if (groupe) {
          if (!groupe.length) return { manque: [`les adresses de « ${qui} » (aucun compte actif de la Direction dans l'annuaire)`] };
          out.push(...groupe.filter((g) => !out.some((d) => d.email === g.email)));
          continue;
        }
        const r = await resoudreDestinataire(qui);
        if (r.ok) out.push(r.destinataire);
        else if ("ambigu" in r) return { manque: [`laquelle de ces personnes pour « ${qui} » : ${r.ambigu.join(" ; ")}`], precision: "Plusieurs personnes portent ce nom dans l'annuaire." };
        else if (opts.destinataireACompleter && champ === "a") aCompleter = [aCompleter, r.inconnu].filter(Boolean).join(", ");
        else return { manque: [`l'adresse e-mail de « ${r.inconnu} » (personne de ce nom dans l'annuaire)`] };
      }
      return out;
    };
    const a = await resoudre("a");
    if (!Array.isArray(a)) return a;
    if (!a.length && !aCompleter && opts.destinataireACompleter) aCompleter = texte(o, "a") || "le destinataire";
    if (!a.length && !aCompleter) return { manque: ["le destinataire du mail"] };
    const cc = await resoudre("cc");
    if (!Array.isArray(cc)) return cc;
    const lu = lireDocumentMail(o.contenu);
    if (!lu.ok) return { manque: lu.manque };
    const objet = texte(o, "objet").slice(0, 200);
    if (!objet) return { manque: ["l'objet du mail"] };
    const pieces = Array.isArray(o.pieces) ? o.pieces.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
    mails.push({ destinataires: a, cc, objet, document: lu.document, pieces, ...(aCompleter ? { aCompleter } : {}) });
  }
  return { ok: true, mails };
}

export const ENVOI_GMAIL: OperationIA = {
  nom: "envoyer_gmail",
  module: "ASSISTANT_IA",
  libelle: "Mail d'Adam préparé",
  description: "Prépare l'ENVOI (ou le brouillon) de mails par la boîte Gmail d'Adam — une carte pour tous. Préfère `envoyer_mail`.",
  schema: {
    type: "object",
    properties: {
      mails: SCHEMA_MAILS,
      societe: { type: "string", description: "La société d'envoi (charte), si la demande la nomme." },
      brouillon: { type: "boolean", description: "Des brouillons (à l'écran d'Adam) au lieu d'envois — seulement sur demande." },
      a: { type: "string" }, objet: { type: "string" }, corps: { type: "string" }, cc: { type: "string" },
    },
  },
  // Les portes des outils Gmail d'Adam (`adam-tools/commun.ts EXEC`) : la Direction et le Super Admin.
  // P1 bis : le canal d'Adam n'existe que pour le Super Admin (`canalAdamOuvert`) — absent de la sélection des autres.
  ouverte: (u: CurrentUser) => peutUtiliserAssistantIA(u) && canalAdamOuvert(u),

  async proposer(entree, user) {
    const boite = await boiteGmailAdam();
    if (!boite) return { erreur: "La boîte Gmail d'Adam n'est pas reliée (Chief of Staff › Réglages › « Connecter Google »)." };
    if (!boite.envoi) return { erreur: `La boîte Gmail d'Adam (${boite.address}) ne peut pas envoyer : ${boite.raison}.` };
    const brouillon = entree.brouillon === true;
    const prep = await preparerMails(entree.mails, texte(entree, "corps") ? { a: texte(entree, "a"), objet: texte(entree, "objet"), corps: texte(entree, "corps"), cc: texte(entree, "cc") } : undefined);
    if (!("ok" in prep)) return prep;
    const tous = prep.mails.flatMap((m) => m.destinataires.map((d) => d.email));
    const frein = brouillon ? null : await freinGmail(tous);
    if (frein) return { erreur: `Je ne prépare pas ces mails : ${frein}` };
    const signature = await signatureDe(user);
    const charte = await charteDuMail(user, texte(entree, "societe") || null, signature);
    // Les pièces jointes (fichiers du Drive de la personne) : résolues AVANT toute intention — introuvable = une question.
    const jointes = new Map<number, Awaited<ReturnType<typeof piecesDuDrive>> & { ok: true }>();
    for (const [i, m] of prep.mails.entries()) {
      if (!m.pieces.length) continue;
      const r = await piecesDuDrive(user, m.pieces);
      if (!r.ok) return { manque: r.manque };
      jointes.set(i, r);
    }
    const ids: string[] = [];
    const apercus: { titre: string; html: string }[] = [];
    const textes: string[] = [];
    const mails: MailVu[] = [];
    const expediteur = `${boite.address} (Gmail d'Adam)`;
    for (const [i, m] of prep.mails.entries()) {
      // UN rendu (I1) : ce qui part est ce que la carte montre et ce que le modèle observe.
      const r = rendreLeMail(m.document, signature, charte, m.objet);
      textes.push(r.texte);
      const p = await preparerMailAdam({ to: m.destinataires.map((d) => d.email), cc: m.cc.map((d) => d.email), subject: m.objet, text: r.texte, html: r.html, attachments: jointes.get(i)?.pieces ?? [] }, { id: user.id, name: user.name ?? user.email ?? user.id });
      ids.push(p.outboundId);
      apercus.push({ titre: `À ${m.destinataires.map((d) => d.nom ?? d.email).join(", ")} — « ${m.objet} »`, html: r.apercu });
      mails.push({ expediteur, a: m.destinataires.map((d) => (d.nom ? `${d.nom} <${d.email}>` : d.email)), cc: m.cc.map((d) => d.email), objet: m.objet, texte: r.texte, html: r.html });
    }
    const n = prep.mails.length;
    return {
      carte: {
        title: `${brouillon ? (n > 1 ? `${n} brouillons` : "Brouillon") : n > 1 ? `Envoyer ${n} mails` : "Envoyer"} par le Gmail d'Adam (${boite.address})`,
        fields: [
          { label: "De", value: `${boite.address} (Gmail d'Adam) — signé ${signature.nom}, ${charte.societe}` },
          ...prep.mails.map((m, i) => ({ label: n > 1 ? `Mail ${i + 1}` : "À", value: `${m.destinataires.map((d) => (d.nom ? `${d.nom} <${d.email}>` : d.email)).join(", ")} — « ${m.objet} »` })),
          ...[...jointes].map(([i, r]) => ({ label: n > 1 ? `Pièces jointes (mail ${i + 1})` : "Pièces jointes", value: r.pieces.map((x) => x.filename).join(", ") })),
        ],
        warnings: brouillon
          ? ["Les brouillons attendent à l'écran d'Adam (Chief of Staff) ; rien ne part."]
          : ["Fenêtre d'annulation : chaque mail attend le délai réglé (30 s par défaut) avant de partir — « Annuler l'envoi » dedans, rien ne part ; parti, un rectificatif peut suivre."],
        libelleBouton: brouillon ? "Enregistrer le brouillon" : n > 1 ? `Envoyer les ${n} mails` : "Envoyer",
        apercus,
        mails,
      },
      // La charge dit AUSSI ce qui part (destinataires, objet, texte du premier mail) : qui relit la carte — la personne,
      // l'audit — lit le mail, pas des identifiants. L'exécution, elle, ne part que des intentions d'Adam (`outboundIds`).
      args: {
        outboundIds: JSON.stringify(ids), brouillon: brouillon ? "1" : null, destinataires: String(tous.length),
        a: tous.join(", "), objet: prep.mails[0]!.objet, corps: (textes[0] ?? "").slice(0, 6_000),
      },
    };
  },

  async executer(args, user) {
    enregistrerExecuteurGmail();
    const ids = (() => { try { return (JSON.parse(args.outboundIds ?? "[]") as unknown[]).map(String).slice(0, MAILS_MAX); } catch { return []; } })();
    if (!ids.length) return { ok: false, error: "Aucun mail à envoyer." };
    try {
      const rs = [];
      for (const id of ids) rs.push(await confirmerMailAdam(id, user.id, { brouillon: args.brouillon === "1" }));
      await recordAudit({
        actorId: user.id, action: "CREATE", module: "Chief of Staff",
        summary: `${ids.length} mail(s) d'Adam ${args.brouillon === "1" ? "laissé(s) en brouillon" : "approuvé(s) (fenêtre d'annulation)"} — confirmé(s) par la personne, ${args.destinataires ?? "?"} destinataire·s`,
      });
      if (rs.every((r) => r.neutralise)) return { ok: true, message: "Simulation : rien n'est parti." };
      if (rs.every((r) => r.brouillon)) return { ok: true, message: `${ids.length > 1 ? `${ids.length} brouillons enregistrés` : "Brouillon enregistré"} à l'écran d'Adam : rien n'est parti.`, link: "/chief-of-staff" };
      const d = rs.map((r) => r.differe).filter((x): x is NonNullable<typeof x> => !!x)[0];
      return { ok: true, message: d ? `${ids.length > 1 ? `${ids.length} mails programmés` : "Mail programmé"} par le Gmail d'Adam : départ à ${d.executeLe.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Algiers" })} — « Annuler l'envoi » jusque-là.` : "Envoyé par le Gmail d'Adam." };
    } catch (e) {
      return { ok: false, error: `Envoi par le Gmail d'Adam impossible : ${e instanceof Error ? e.message : String(e)}.` };
    }
  },
};
