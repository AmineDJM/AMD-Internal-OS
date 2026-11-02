/**
 * LA CARTE DE LA PLATEFORME — ce qui se CALCULE du catalogue : les circuits qui passent par un
 * module, les modules voisins. Jamais recopié à la main.
 */
import type { Circuit } from "./types";
import { MODULES_PLATEFORME } from "./modules";
import { CIRCUITS } from "./circuits";

/** Les circuits qui passent par un module — calculés, jamais recopiés. */
export function circuitsDuModule(moduleId: string): Circuit[] {
  return CIRCUITS.filter((c) => c.etapes.some((e) => e.module === moduleId));
}

/** Les modules reliés dans les deux sens (un lien déclaré d'un côté suffit). */
export function voisinsDuModule(moduleId: string): string[] {
  const out = new Set<string>();
  for (const m of MODULES_PLATEFORME) {
    if (m.id === moduleId) m.liens.forEach((l) => out.add(l.vers));
    else if (m.liens.some((l) => l.vers === moduleId)) out.add(m.id);
  }
  out.delete(moduleId);
  return [...out];
}
