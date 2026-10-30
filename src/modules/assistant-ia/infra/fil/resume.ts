import type { AssistantIaTour } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { genererTexte } from "../generer";
import { auNomDe } from "../consommation";
import { censurerTexte, sansValeursRevelees } from "../../domaine/filtre-confidentialite";
import { aCompacter, borner, CONSIGNE_RESUME, texteAResumer, type TourResumable } from "../../domaine/fil/resume";

/**
 * LE RÉSUMÉ ROULANT, CÔTÉ BASE (J4, décision 0018) — la règle est pure (`domaine/fil/resume.ts`) ; ici, on lit les
 * échanges aboutis du fil, on confie au modèle RAPIDE ceux qui sortent de la fenêtre, on garde le résumé.
 *
 * Joué APRÈS la réponse (elle est déjà écrite et notifiée) : le résumé ne retarde aucun premier mot. Une panne du
 * modèle laisse le résumé précédent tel quel — le tour suivant garde simplement un peu plus d'échanges mot pour mot.
 */

/** Ce que le modèle peut relire d'un tour : le texte filtré, les valeurs révélées redevenues « [confidentiel] ». */
export function pourResume(role: "user" | "assistant", contenu: string): string {
  return censurerTexte(role === "assistant" ? sansValeursRevelees(contenu) : contenu).texte;
}

/** Les échanges ABOUTIS du fil depuis « nouvelle conversation », chaque réponse datée de sa question. */
export function echangesAboutis(tours: readonly AssistantIaTour[]): (TourResumable & { id: string })[] {
  const questions = new Map(tours.filter((t) => t.role === "user" && t.etat === "TRAITE").map((t) => [t.id, t]));
  const out: (TourResumable & { id: string })[] = [];
  for (const q of [...questions.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const r = tours.find((t) => t.role === "assistant" && t.repondA === q.id && t.etat === "TERMINE");
    if (!r) continue;
    out.push({ id: q.id, role: "user", content: q.contenu, quand: q.createdAt }, { id: r.id, role: "assistant", content: r.contenu, quand: q.createdAt });
  }
  return out;
}

/** Résume ce qui est sorti de la fenêtre, si c'est le moment. Ne lève jamais ; rend ce qui a été fait. */
export async function compacterFil(filId: string): Promise<{ fait: boolean; raison?: string }> {
  try {
    const fil = await prisma.assistantIaFil.findUnique({ where: { id: filId } });
    if (!fil) return { fait: false, raison: "fil introuvable" };
    const tours = await prisma.assistantIaTour.findMany({ where: { filId, createdAt: { gte: fil.depuisLe } }, orderBy: { createdAt: "asc" } });
    const plan = aCompacter(echangesAboutis(tours), fil.resumeJusquA);
    if (!plan) return { fait: false, raison: "rien à résumer" };
    const filtres = plan.aResumer.map((t) => ({ ...t, content: pourResume(t.role, t.content) }));
    const r = await auNomDe(fil.userId, () => genererTexte(CONSIGNE_RESUME, texteAResumer(fil.resume, filtres), 30_000, { role: "rapide" }), filId);
    if (!r.ok) return { fait: false, raison: r.raison };
    const resume = borner(censurerTexte(r.texte).texte);
    // Écrit seulement si personne n'a résumé entre-temps (deux passages concurrents ne s'écrasent pas).
    const ecrit = await prisma.assistantIaFil.updateMany({
      where: { id: filId, resumeJusquA: fil.resumeJusquA, depuisLe: fil.depuisLe },
      data: { resume, resumeJusquA: plan.jusquA, resumeLe: new Date() },
    });
    return ecrit.count ? { fait: true } : { fait: false, raison: "déjà résumé par un autre passage" };
  } catch (e) {
    console.error("[assistant-fil] résumé roulant", filId, e);
    return { fait: false, raison: e instanceof Error ? e.message : String(e) };
  }
}
