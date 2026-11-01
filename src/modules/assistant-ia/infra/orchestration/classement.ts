import { auNomDe } from "../consommation";
import { genererTexte } from "../generer";
import {
  CONSIGNE_CLASSEMENT, classerParRepli, classerSansModele, entreeClassement, lireClassement, type Classement,
} from "../../domaine/conversation/classement";
import type { Forme, Impact } from "../../domaine/conversation/agenda";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLASSEMENT D'UN ÉNONCÉ PENDANT UN TRAVAIL (lot O1, décision 0046) — précision (majeure / mineure), autre demande,
 * conversation. Les cas évidents se jugent SANS modèle (`classerSansModele`) ; le reste par un classifieur bon marché :
 * rôle `rapide`, entrée courte (demande en cours, question posée, énoncé), sortie JSON stricte, 8 s au plus, imputé à la
 * personne et journalisé comme tout appel (K8 : `auNomDe`, coût mesuré). Muet ou illisible : le repli décide — et le dit.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export async function classerEnonce(userId: string, conversation: string | null, d: {
  enonce: string; demandeEnCours: string;
  question: { id: string; texte: string; cle: string; choix: string[]; impact: Impact; forme: Forme | null } | null;
}): Promise<Classement> {
  const evident = classerSansModele(d.enonce, d.question);
  if (evident) return evident;
  const r = await auNomDe(userId, () => genererTexte(
    CONSIGNE_CLASSEMENT,
    entreeClassement({ demandeEnCours: d.demandeEnCours, question: d.question?.texte ?? null, enonce: d.enonce }),
    8_000, { role: "rapide" },
  ), conversation).catch((e: unknown) => ({ ok: false as const, raison: e instanceof Error ? e.message : String(e) }));
  const lu = r.ok ? lireClassement(r.texte) : null;
  if (lu) {
    console.info("[assistant-ia] classement", { userId, nature: lu.nature, impact: lu.impact, source: "classifieur" });
    return { ...lu, consigne: lu.consigne || d.enonce.trim(), source: "classifieur" };
  }
  const repli = classerParRepli(d.enonce);
  console.warn("[assistant-ia] classement : repli", { userId, raison: r.ok ? "sortie illisible" : r.raison, nature: repli.nature });
  return repli;
}
