/**
 * CE QUE LA GARDE AURAIT REFUSÉ (lot D3, décision 0057) — compté en mémoire, écrit par paquets.
 *
 * Le chemin de la requête ne fait qu'incrémenter un compteur (aucune écriture en base, aucune attente). Les compteurs
 * partent en base toutes les 30 s au plus, par le client BRUT (`prismaBrut`) et dans le contexte SYSTÈME : l'écriture
 * du journal ne repasse jamais par la garde qu'elle mesure.
 */
import { prismaBrut } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { enSysteme } from "@/platform/donnees/contexte";

const DELAI_MS = 30_000;
const MAX_MODELES = 12;

interface Compteur {
  jour: string;
  base: string;
  userId: string;
  geste: string;
  niveau: string;
  modeles: Set<string>;
  nombre: number;
}

const enAttente = new Map<string, Compteur>();
let prochainEnvoi = 0;
let envoiEnCours: Promise<void> | null = null;

export function compterObservation(o: { base: string; userId: string; geste: string; niveau: string; modele: string }): void {
  const jour = new Date().toISOString().slice(0, 10);
  const cle = `${jour}|${o.base}|${o.userId}|${o.geste}`;
  const c = enAttente.get(cle) ?? { jour, base: o.base, userId: o.userId, geste: o.geste, niveau: o.niveau, modeles: new Set<string>(), nombre: 0 };
  c.nombre += 1;
  c.niveau = o.niveau;
  if (c.modeles.size < MAX_MODELES) c.modeles.add(o.modele);
  enAttente.set(cle, c);
  if (!envoiEnCours && Date.now() >= prochainEnvoi) void envoyerObservations().catch(sansBloquer("acces-bases: journal d'observation"));
}

/** Écrit les compteurs en attente (cumulés à ceux du jour). Rend la main quand tout est écrit. */
export function envoyerObservations(): Promise<void> {
  if (envoiEnCours) return envoiEnCours;
  prochainEnvoi = Date.now() + DELAI_MS;
  const lot = [...enAttente.values()];
  enAttente.clear();
  envoiEnCours = enSysteme("journal d'observation de l'accès par base", async () => {
    for (const c of lot) {
      const jour = new Date(`${c.jour}T00:00:00.000Z`);
      const existant = await prismaBrut.observationAccesBase.findUnique({
        where: { jour_base_userId_geste: { jour, base: c.base, userId: c.userId, geste: c.geste } },
        select: { modeles: true },
      });
      const modeles = [...new Set([...(existant?.modeles ?? []), ...c.modeles])].slice(0, MAX_MODELES);
      await prismaBrut.observationAccesBase.upsert({
        where: { jour_base_userId_geste: { jour, base: c.base, userId: c.userId, geste: c.geste } },
        create: { jour, base: c.base, userId: c.userId, geste: c.geste, niveau: c.niveau, modeles, nombre: c.nombre },
        update: { niveau: c.niveau, modeles, nombre: { increment: c.nombre }, dernierLe: new Date() },
      });
    }
  }).finally(() => { envoiEnCours = null; });
  return envoiEnCours;
}

/** Les observations récentes (par défaut 14 jours), pour la console : par base, par personne, par geste. */
export function observationsRecentes(jours = 14) {
  const depuis = new Date(Date.now() - jours * 86_400_000);
  depuis.setUTCHours(0, 0, 0, 0);
  return prismaBrut.observationAccesBase.findMany({ where: { jour: { gte: depuis } }, orderBy: [{ jour: "desc" }, { nombre: "desc" }], take: 500 });
}
