import { actionAsyncStorage } from "next/dist/server/app-render/action-async-storage.external";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { journaliser } from "@/lib/journal";
import { clientGardeEtendu, prismaBrut } from "@/lib/prisma";
import { cleDeRequete, poserVueExacteDeRequete, vueExacteDeRequete, type VueExacteDeRequete } from "@/lib/vue-exacte-requete";
import { extensionCapture, finaliserCapture } from "./capture";
import { consolider } from "./diff";
import { effetEnLigne, idDeGeste, inscrire } from "./journal";
import { poserFournisseurDeGesteDeRequete, type Capture, type EtatGeste } from "./magasin";

export { poserVueExacteDeRequete };

/** L'origine au journal des gestes faits en « Agir comme cet utilisateur ». */
export const ORIGINE_AGIR_COMME = "vue-exacte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TOUT CE QU'UN SUPER ADMIN FAIT EN « AGIR COMME » S'ANNULE (Direction, 16/11/2026).
 *
 * Une requête en « Agir comme » (posée par la session, `lib/vue-exacte-requete.ts`) porte un GESTE DE REQUÊTE : le relais
 * Prisma la sert par le client gardé qui CAPTE (chaque écriture garde sa ligne avant / après), et ses écritures entrent au
 * journal des effets — une entrée par requête (une action, une route d'API, un affichage qui écrit), au nom de la personne,
 * marquée du Super Admin (`parVueExacteId`). La page « Agir comme — vos gestes » (`/admin/agir-comme`) les liste et les
 * annule, tout ou rien, comme un geste d'écran (`annulation.ts`).
 *
 * L'entrée s'écrit APRÈS LE CALME (plus rien ne tourne depuis un instant), avec l'état final des lignes touchées ; ce qui
 * s'écrit encore ensuite s'y ajoute à la suite. Un geste déjà journalisé (`gesteReversible`, une carte) garde son entrée à
 * lui, marquée du même Super Admin (`journal.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface GesteDeVue {
  etat: EtatGeste;
  vue: VueExacteDeRequete;
  libelle: string;
  capaciteId: string;
  /** Combien d'écritures de la capture sont déjà au journal. */
  inscrites: number;
  journalId: string | null;
  ordre: number;
  prevu: boolean;
  chaine: Promise<void>;
}

const g = globalThis as { __amdGestesDeVue?: WeakMap<object, GesteDeVue>; __amdClientDeVue?: unknown };
const gestes = (g.__amdGestesDeVue ??= new WeakMap<object, GesteDeVue>());
const clientDeVue = () => (g.__amdClientDeVue ??= clientGardeEtendu(extensionCapture(prismaBrut as unknown as Record<string, unknown>)));

/** Le geste de la requête en cours si elle est en « Agir comme » — créé à la première demande. */
function gesteDeLaVue(): EtatGeste | null {
  const k = cleDeRequete();
  if (!k) return null;
  const deja = gestes.get(k);
  if (deja) return deja.etat;
  const vue = vueExacteDeRequete();
  if (!vue) return null;
  const gv = ouvrir(vue);
  gestes.set(k, gv);
  return gv.etat;
}

function ouvrir(vue: VueExacteDeRequete): GesteDeVue {
  let route = "?";
  let action = false;
  try {
    route = (workAsyncStorage.getStore() as { route?: string } | undefined)?.route ?? "?";
    action = actionAsyncStorage.getStore()?.isAction === true;
  } catch {
    /* hors requête : rien à nommer */
  }
  const capture: Capture = { ecritures: [], effets: [] };
  const gv: GesteDeVue = {
    etat: {
      mode: "REEL", user: null, principalId: vue.cibleId, origine: ORIGINE_AGIR_COMME, debut: Date.now(),
      capture, client: clientDeVue(), gesteId: null, fenetre: false,
    },
    vue,
    libelle: `${action ? "Action" : route.startsWith("/api/") ? "Envoi" : "Affichage"} sur ${route} — en tant que ${vue.cibleNom}`,
    capaciteId: `vue-exacte:${route}`,
    inscrites: 0, journalId: null, ordre: 0, prevu: false, chaine: Promise.resolve(),
  };
  capture.tardive = () => planifier(gv);
  return gv;
}

/** Attend le calme de la requête (plus aucune requête en vol depuis un instant), borné. */
async function calme(capture: Capture, calmeMs = 200, maxMs = 5_000): Promise<void> {
  const fin = Date.now() + maxMs;
  await new Promise((r) => setTimeout(r, 25));
  while (Date.now() < fin && ((capture.enVol ?? 0) > 0 || Date.now() - (capture.derniere ?? 0) < calmeMs)) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

function planifier(gv: GesteDeVue): void {
  if (gv.prevu) return;
  gv.prevu = true;
  gv.chaine = gv.chaine
    .then(() => inscrireLaSuite(gv))
    .catch((e) => journaliser("erreur", "effets.agir-comme", { superAdmin: gv.vue.superAdminId, personne: gv.vue.cibleId }, e));
}

async function inscrireLaSuite(gv: GesteDeVue): Promise<void> {
  const capture = gv.etat.capture!;
  await calme(capture);
  gv.prevu = false;
  const nouvelles = capture.ecritures.slice(gv.inscrites);
  gv.inscrites = capture.ecritures.length;
  if (!nouvelles.length) return;
  const lot: Capture = { ecritures: nouvelles, effets: [] };
  await finaliserCapture(lot, prismaBrut as unknown as Record<string, unknown>, { calmeMs: 0, maxMs: 100 });
  if (!gv.journalId) {
    const fait = await inscrire(
      idDeGeste(), gv.vue.cibleId,
      { origine: ORIGINE_AGIR_COMME, capaciteId: gv.capaciteId, libelle: gv.libelle, parVueExacteId: gv.vue.superAdminId },
      lot, { ok: true, message: null }, { debut: gv.etat.debut, fin: Date.now() },
    );
    gv.journalId = fait?.id ?? null;
    gv.ordre = consolider(nouvelles).length;
    return;
  }
  for (const e of consolider(nouvelles)) {
    await prismaBrut.assistantEffet.create({ data: { gesteId: gv.journalId, ...effetEnLigne(e, gv.ordre++) } });
  }
}

poserFournisseurDeGesteDeRequete(gesteDeLaVue);
