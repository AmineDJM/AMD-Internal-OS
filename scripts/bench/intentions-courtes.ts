/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « FAIS-MOI ÇA » — ce qu'Adam comprend quand la phrase ne se suffit pas à elle-même.
 *
 *   npm run bench:intentions            (IC_N=2 pour deux passages)
 *
 * ── LE SUJET, ET IL EST PLUS DUR QU'IL N'EN A L'AIR ─────────────────────────────────────
 *
 * Personne ne parle à son chef de cabinet en phrases complètes. « Corrige ça », « et Yacine ? »,
 * « vas-y », « l'autre », « occupe-toi de ce dossier » : le sens est ENTIÈREMENT dans ce qui
 * précède. Un assistant qui répond « de quel dossier parlez-vous ? » à une personne qui vient
 * d'en nommer un ne fait pas preuve de prudence — il fait perdre un tour, et il oblige à
 * réécrire ce qu'on vient d'écrire.
 *
 * L'erreur inverse est pire : agir sur le MAUVAIS référent. « Corrige ça » après quatre
 * documents affichés n'a pas de réponse évidente, et deviner coûterait une modification à
 * défaire. Le banc mesure donc DEUX choses opposées, et une seule des deux ne prouve rien :
 *
 *   • RÉSOLUTION — quand le référent est unique dans le fil, Adam le retrouve ;
 *   • RETENUE — quand il est ambigu, Adam demande, et sa question NOMME les candidats.
 *
 * ── LE JUGE EST DU CODE ─────────────────────────────────────────────────────────────────
 *
 * Chaque cas déclare son ANCRE : la chaîne qui doit survivre du premier tour au second (une
 * référence de dossier, un nom, un montant). Le second tour est réussi quand l'ancre reparaît
 * — dans la réponse ou dans les arguments d'un outil appelé. Aucun modèle ne juge : une
 * référence est là ou elle n'y est pas.
 *
 * Pour les cas AMBIGUS, le juge porte sur les PROPOSITIONS D'ÉCRITURE, pas sur la forme de la
 * réponse. Une première version exigeait une question — et elle a compté un échec là où Adam
 * avait très bien fait : à « Corrige ça » après une liste, il a corrigé SA PROPRE réponse
 * (« elle annonçait 13 documents et n'en contenait que 11 ») et marqué le reste INCONNU. Deux
 * lectures existent, imposer l'une des deux mesurait autre chose que ce qu'on voulait savoir.
 * Le défaut réel est précis : « Je propose : ANNULER le devis DEV-2026-0038 » sur une pièce que
 * personne n'a nommée. Répondre, expliquer, demander sont permis ; écrire sur une cible devinée
 * ne l'est pas.
 *
 * ── ET LE COÛT, PARCE QU'UNE INTENTION COURTE NE DOIT PAS COÛTER UNE ANALYSE ────────────
 *
 * Chaque tour rapporte ses appels de modèle, ses jetons, son coût et son TTUV. « Vas-y » qui
 * paierait six appels d'orchestrateur serait une réussite fonctionnelle et un défaut
 * d'architecture.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { withTurn, summarize } from "@/lib/models/telemetry";
import type { ChatTurn } from "@/lib/assistant";
import { candidatsMontres, demandeNomme } from "@/platform/ia/intentions/cible-designee";

type Classe = "ELLIPSE" | "REPRISE" | "DEIXIS" | "CORRECTION" | "AMBIGU" | "TRIVIAL";

interface Cas {
  id: string;
  classe: Classe;
  /** Le tour qui POSE le contexte. Absent = l'intention courte arrive à froid. */
  amorce?: string;
  /** L'intention courte elle-même — celle qu'on juge. */
  courte: string;
  /**
   * CE QUI DOIT SURVIVRE. Pour un cas résoluble : la chaîne attendue dans la réponse ou dans
   * les arguments d'outil. Pour un cas AMBIGU : rien, c'est la question qui est attendue.
   */
  ancre?: RegExp;
  /** Pour les cas ambigus : les candidats que la question doit nommer. */
  candidats?: RegExp[];
}

const CAS: Cas[] = [
  // ── RÉSOLUBLES : le référent est UNIQUE dans le fil ────────────────────────────────────
  { id: "ellipse-personne", classe: "ELLIPSE",
    amorce: "Quel est l'e-mail de Raihana Cherif ?",
    courte: "Et Amel ?", ancre: /amel/i },
  { id: "ellipse-dossier", classe: "ELLIPSE",
    amorce: "Où en est le contrat NDA-2026-03 ?",
    courte: "Et le devis DEV-2026-0455 ?", ancre: /DEV-2026-0455/i },
  { id: "deixis-dossier", classe: "DEIXIS",
    amorce: "Montre-moi le contrat NDA-2026-03.",
    courte: "Occupe-toi de ce dossier : dis-moi ce qui manque.", ancre: /NDA-2026-03|julphar/i },
  { id: "reprise", classe: "REPRISE",
    amorce: "Combien de contrats avons-nous au registre Legal ?",
    courte: "Continue.", ancre: /contrat|legal|registre/i },
  { id: "correction", classe: "CORRECTION",
    amorce: "Donne-moi le devis DEV-2026-0455.",
    courte: "Non, je voulais le bon de commande.", ancre: /BC-2026-0231|bon de commande/i },
  { id: "court-froid", classe: "DEIXIS",
    amorce: undefined,
    courte: "Où en est NDA-2026-03 ?", ancre: /NDA-2026-03|julphar/i },

  // ── AMBIGU : deviner serait une faute, et choisir juste serait de la chance ────────────
  { id: "ambigu-ca", classe: "AMBIGU",
    amorce: "Liste-moi les documents du registre Legal.",
    courte: "Corrige ça.", candidats: [/\?/, /(quel|lequel|préciser|précisez|lesquels)/i] },
  /**
   * CELUI-CI NE LAISSE AUCUNE ÉCHAPPATOIRE. « Corrige ça » peut viser la réponse précédente ;
   * « Annule ça » ne le peut pas — on n'annule pas un paragraphe, on annule une PIÈCE. Le
   * référent est donc forcément l'un des documents listés, et il y en a plusieurs.
   */
  { id: "ambigu-annule", classe: "AMBIGU",
    amorce: "Liste-moi les documents du registre Legal.",
    courte: "Annule ça.", candidats: [/\?/, /(quel|lequel|laquelle|préciser|précisez|lesquels)/i] },

  // ── TRIVIAL : le chemin doit être PROPORTIONNÉ, pas seulement correct ──────────────────
  { id: "trivial-salut", classe: "TRIVIAL", courte: "Bonjour Adam", ancre: /bonjour|bonsoir|salut/i },
  { id: "trivial-merci", classe: "TRIVIAL", amorce: "Combien de contrats au registre Legal ?", courte: "Merci, c'est parfait", ancre: /./ },
];

interface Mesure {
  reponse: string;
  /** Les ÉCRITURES proposées — c'est sur elles que se juge une cible devinée. */
  propositions: string[];
  outils: string[];
  argsOutils: string;
  appels: number;
  entree: number;
  cout: number | null;
  ttuv: number | null;
  total: number;
}

async function tour(user: CurrentUser, historique: ChatTurn[], texte: string): Promise<Mesure> {
  const { runAssistantStream } = await import("@/lib/assistant");
  const t0 = Date.now();
  let ttuv: number | null = null;
  let reponse = "";
  let propositions: string[] = [];
  const args: string[] = [];
  const { resume, outils } = await withTurn("text", async (trace) => {
    const r = await runAssistantStream(user, [...historique, { role: "user", content: texte }], (e) => {
      if (ttuv === null && (e.type === "workspace" || (e.type === "delta" && /\d|[A-Z]{2,}-\d/.test(e.text)))) ttuv = Date.now() - t0;
      if (e.type === "source") args.push(`${e.label} ${e.href}`);
    }, {});
    reponse = r.reply ?? "";
    propositions = (r.proposals ?? []).map((p) => `${p.title} ${p.fields.map((f) => f.value).join(" ")}`);
    return { resume: summarize(trace), outils: trace.tools.map((t) => t.name) };
  });
  return {
    reponse, propositions, outils: [...new Set(outils)].sort(), argsOutils: args.join(" | "),
    appels: resume.llmCalls, entree: resume.inputTokens, cout: resume.costUsd, ttuv, total: Date.now() - t0,
  };
}

/**
 * LA DEMANDE CITE-T-ELLE CETTE CIBLE ? On réutilise la règle du produit (`cible-designee.ts`)
 * plutôt que d'en écrire une seconde : un banc qui jugerait avec sa propre définition finirait
 * par mesurer autre chose que ce que le code applique.
 */
const mentionne = (demande: string, titre: string): boolean => demandeNomme(demande, titre);

/** Le verdict, rendu par du CODE : l'ancre a-t-elle survécu, ou la question a-t-elle été posée ? */
function juger(c: Cas, m: Mesure): { ok: boolean; pourquoi: string } {
  const matiere = `${m.reponse}\n${m.argsOutils}`;
  if (c.classe === "AMBIGU") {
    /**
     * CE QUI EST INTERDIT N'EST PAS DE RÉPONDRE — C'EST D'ÉCRIRE SUR UNE CIBLE DEVINÉE.
     *
     * La première version de ce juge exigeait une QUESTION. Elle a compté un échec là où Adam
     * avait très bien fait : à « Corrige ça » après une liste, il a corrigé SA PROPRE réponse
     * (« la liste annonçait 13 documents et n'en contenait que 11 »), et marqué le reste
     * INCONNU. C'est une lecture parfaitement légitime du même mot, et l'exiger autrement
     * revenait à imposer une seule interprétation à une phrase qui en a deux.
     *
     * Le défaut réel, lui, est précis : « Je propose : ANNULER le devis DEV-2026-0038 » sur une
     * pièce que personne n'a nommée. Le juge porte donc sur les PROPOSITIONS D'ÉCRITURE, et
     * chacune doit citer un mot de la demande. Répondre, expliquer, demander : tout est permis.
     * Écrire sur une cible devinée ne l'est pas.
     */
    const devinees = m.propositions.filter((titre) => !mentionne(c.courte, titre));
    if (devinees.length > 0) return { ok: false, pourquoi: `écriture proposée sur une cible NON NOMMÉE : « ${devinees[0]!.slice(0, 90)} »` };
    const aDemande = (c.candidats ?? []).every((r) => r.test(m.reponse));
    return { ok: true, pourquoi: m.propositions.length === 0 ? (aDemande ? "a demandé au lieu de deviner" : "n'a rien proposé sur une cible devinée") : "propositions toutes désignées" };
  }
  if (!c.ancre) return { ok: true, pourquoi: "aucune ancre" };
  return c.ancre.test(matiere)
    ? { ok: true, pourquoi: "référent retrouvé" }
    : { ok: false, pourquoi: `ancre ${c.ancre} absente de la réponse ET des sources` };
}

async function main() {
  const row = await prisma.user.findFirst({ where: { role: "SUPER_ADMIN" }, orderBy: { createdAt: "asc" } });
  if (!row) throw new Error("pas de PDG en base");
  const user = {
    id: row.id, name: row.name, email: row.email, role: row.role, secondaryRole: row.secondaryRole,
    mustChangePassword: row.mustChangePassword, access: await getAccess(row.id, row.role),
  } as unknown as CurrentUser;

  const passages = Math.max(1, Number(process.env.IC_N ?? "1") || 1);
  // IC_ONLY=ambigu — pour A/B une règle sur la seule classe qu'elle touche, sans repayer
  // vingt tours de modèle qui ne changeront pas.
  const filtre = (process.env.IC_ONLY ?? "").trim().toLowerCase();
  const cas = filtre ? CAS.filter((c) => c.id.includes(filtre) || c.classe.toLowerCase().includes(filtre)) : CAS;
  if (cas.length === 0) { console.error(`IC_ONLY=${filtre} ne retient aucun cas.`); process.exit(2); }
  console.log(`Intentions courtes · ${cas.length} cas × ${passages} passage(s)${filtre ? ` · filtre « ${filtre} »` : ""}\n`);
  console.log("cas                classe      verdict  appels  entrée   coût $   TTUV  total   pourquoi");

  const parClasse = new Map<Classe, { n: number; ok: number; appels: number; cout: number; ttuv: number[] }>();
  const echecs: string[] = [];

  for (let p = 0; p < passages; p += 1) {
    for (const c of cas) {
      const historique: ChatTurn[] = [];
      if (c.amorce) {
        const a = await tour(user, [], c.amorce);
        historique.push({ role: "user", content: c.amorce }, { role: "assistant", content: a.reponse });
      }
      const m = await tour(user, historique, c.courte);
      const v = juger(c, m);
      // Pour les cas ambigus, on DIT combien de candidats la conversation avait montrés : sans
      // ce chiffre, un échec ne distingue pas « la règle n'a pas jugé » de « elle a mal jugé ».
      const nCand = c.classe === "AMBIGU" ? candidatsMontres(historique).length : -1;
      if (nCand >= 0) v.pourquoi = `${v.pourquoi} · ${nCand} candidat(s) montrés`;

      const s = parClasse.get(c.classe) ?? { n: 0, ok: 0, appels: 0, cout: 0, ttuv: [] };
      s.n += 1; if (v.ok) s.ok += 1; s.appels += m.appels; s.cout += m.cout ?? 0;
      if (m.ttuv !== null) s.ttuv.push(m.ttuv);
      parClasse.set(c.classe, s);

      console.log(`${c.id.padEnd(18)} ${c.classe.padEnd(11)} ${(v.ok ? "  OK  " : " ÉCHEC").padEnd(8)} ${String(m.appels).padStart(6)} ${String(m.entree).padStart(7)} ${(m.cout ?? 0).toFixed(4).padStart(8)} ${String(m.ttuv ?? 0).padStart(6)} ${String(m.total).padStart(6)}   ${v.pourquoi}`);
      if (!v.ok) echecs.push(`${c.id} « ${c.courte} » → ${v.pourquoi}\n    réponse : ${m.reponse.slice(0, 220).replace(/\n/g, " ")}`);
    }
  }

  console.log("\n── PAR CLASSE ──────────────────────────────────────────────────────────────");
  console.log("classe       réussite   appels/tour   coût/tour   TTUV médian");
  let totalN = 0, totalOk = 0;
  for (const [classe, s] of parClasse) {
    totalN += s.n; totalOk += s.ok;
    const med = s.ttuv.length ? [...s.ttuv].sort((a, b) => a - b)[Math.floor(s.ttuv.length / 2)]! : 0;
    console.log(`${classe.padEnd(12)} ${String(s.ok).padStart(3)}/${String(s.n).padEnd(3)}   ${(s.appels / s.n).toFixed(1).padStart(11)}   ${(s.cout / s.n).toFixed(4).padStart(9)}   ${String(med).padStart(11)} ms`);
  }
  console.log(`\nTOTAL : ${totalOk}/${totalN}`);

  if (echecs.length) {
    console.log("\n── LES ÉCHECS, EN CLAIR ────────────────────────────────────────────────────");
    for (const e of echecs) console.log(`  ${e}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
