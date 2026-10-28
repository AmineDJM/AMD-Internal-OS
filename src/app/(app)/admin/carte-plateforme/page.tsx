import { redirect } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { PERMISSIONS, type Module } from "@/lib/rbac";
import { MODULE_LABELS, ROLE_LABELS } from "@/lib/labels";
import { isRetiredModule } from "@/lib/modules-retired";
import { MODULES_PLATEFORME } from "@/lib/carte-plateforme/catalogue";
import { LIBELLES_ACTION, meilleurNiveau, niveauDe, type MatriceAcces, type Niveau } from "@/lib/carte-plateforme/acces";
import { CartePlateforme } from "./carte-plateforme";

export const metadata = { title: "Carte de la plateforme — AMD Internal OS" };
export const dynamic = "force-dynamic";

/**
 * LA CARTE DE LA PLATEFORME — comprendre l'ERP d'un regard : ses modules, ce que chacun fait et qui le
 * fait, les circuits de bout en bout, et les droits par défaut de chaque rôle. Super Admin seul.
 *
 * Les descriptions viennent du catalogue (`lib/carte-plateforme/catalogue.ts`) ; les DROITS, eux, sont
 * lus ici dans `PERMISSIONS` à chaque rendu — jamais recopiés —, si bien qu'un rôle modifié dans
 * `rbac.ts` change la carte sans qu'on y touche.
 */

type Params = Record<string, string | string[] | undefined>;
const un = (p: Params | undefined, k: string): string | null => {
  const v = p?.[k];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

export default async function CartePlateformePage(props: { searchParams?: Promise<Params> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  // RÉSERVÉ AU SUPER ADMINISTRATEUR — aucun droit de module ne l'ouvre à un autre rôle.
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard?denied=ADMIN");

  const roles = Object.keys(ROLE_LABELS);
  const acces: MatriceAcces = {};
  for (const m of MODULES_PLATEFORME) {
    const parRole: MatriceAcces[string] = {};
    for (const role of roles) {
      const matrice: Partial<Record<Module, readonly string[]>> = PERMISSIONS[role as UserRole] ?? {};
      const niveaux: Niveau[] = [];
      const detail: string[] = [];
      for (const cle of m.rbac) {
        // Un module retiré n'entre dans l'accès de personne, Super Admin compris (`getAccess`).
        const actions = isRetiredModule(cle) ? [] : (matrice[cle as Module] ?? []);
        niveaux.push(niveauDe(actions));
        const libelle = MODULE_LABELS[cle as Module] ?? cle;
        detail.push(`${libelle} : ${actions.length ? actions.map((a) => LIBELLES_ACTION[a] ?? a).join(", ") : "aucun accès"}`);
      }
      parRole[role] = { niveau: meilleurNiveau(niveaux), detail };
    }
    acces[m.id] = parRole;
  }

  const vue = un(searchParams, "vue");
  return (
    <CartePlateforme
      acces={acces}
      roles={roles.map((r) => ({ cle: r, libelle: ROLE_LABELS[r] ?? r }))}
      vueInitiale={vue === "circuits" || vue === "roles" || vue === "regles" ? vue : "carte"}
      moduleInitial={un(searchParams, "module")}
      circuitInitial={un(searchParams, "circuit")}
    />
  );
}
