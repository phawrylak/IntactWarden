/**
 * Package paths of the toolbar icons. The icons are
 * committed files in extension/assets/icons/: one SVG per lattice icon plus the CHECKING spinner
 * (Firefox's `action.setIcon` accepts SVG at every size), and the product icon (the `default`
 * shield) as `assets/icons/icon-<size>.png`, as the manifest names it. The build copies exactly
 * these files. Pure: no extension API, so the build and the action controller share it.
 */

import type {Icon} from '@intactwarden/core/verdict/states.ts';

/** Toolbar icons: the verdict lattice's icons plus the grey CHECKING spinner. */
export type ActionIcon = Icon | 'grey-spinner';

const ICON_SET: Readonly<Record<ActionIcon, true>> = {
  'red-bang': true,
  'red-outline': true,
  amber: true,
  'amber-spinner': true,
  'grey-outline': true,
  'grey-spinner': true,
  'green-solid': true,
  default: true,
};

/** Every toolbar icon, in a fixed order. */
export const ACTION_ICONS: readonly ActionIcon[] = Object.freeze(
  Object.keys(ICON_SET) as ActionIcon[],
);

export const ICON_DIR = 'assets/icons';
/** Sizes named in the `action.setIcon` path dictionary (all point at the same SVG). */
export const ACTION_ICON_SIZES: readonly number[] = Object.freeze([16, 32]);
/** PNG sizes of the product icon (`icons` and `action.default_icon` of the manifest). */
export const PRODUCT_ICON_SIZES: readonly number[] = Object.freeze([16, 32, 48, 128]);

/** `assets/icons/icon-<size>.png`. */
export function productIconPath(size: number): string {
  return `${ICON_DIR}/icon-${size}.png`;
}

/** Package path of one toolbar icon file: `assets/icons/state/<icon>.svg`. */
export function actionIconFile(icon: ActionIcon): string {
  return `${ICON_DIR}/state/${icon}.svg`;
}

/** The `path` argument of `action.setIcon` for `icon`. */
export function actionIconPaths(icon: ActionIcon): Record<string, string> {
  const out: Record<string, string> = {};
  for (const size of ACTION_ICON_SIZES) out[String(size)] = actionIconFile(icon);
  return out;
}
