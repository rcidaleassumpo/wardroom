// SPDX-License-Identifier: Apache-2.0
/**
 * Machine authority identity. AuthorityId names a machine's public identity
 * everywhere Rooms addresses across machines; the branded type prevents a
 * plain session or channel string from standing in for one.
 */
declare const authorityIdBrand: unique symbol;

export type AuthorityId = string & { readonly [authorityIdBrand]: "AuthorityId" };
