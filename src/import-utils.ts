/**
 * @license
 * Copyright (c) 2014 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
import * as dom5 from 'dom5';
import * as parse5 from 'parse5';
import {ASTNode} from 'parse5';
import {Document} from 'polymer-analyzer/lib/model/model';
import * as urlLib from 'url';

import * as astUtils from './ast-utils';
import {AssignedBundle, BundleManifest} from './bundle-manifest';
import constants from './constants';
import * as matchers from './matchers';
import encodeString from './third_party/UglifyJS2/encode-string';
import * as urlUtils from './url-utils';
import {UrlString} from './url-utils';

// TODO(usergenic): Revisit the organization of this module and *consider*
// building a class to encapsulate the common document details like docUrl and
// docBundle and global notions like manifest etc.

/**
 * Inline the contents of the html document returned by the link tag's href
 * at the location of the link tag and then remove the link tag.
 */
export async function inlineHtmlImport(
    document: Document,
    linkTag: ASTNode,
    visitedUrls: Set<UrlString>,
    docBundle: AssignedBundle,
    manifest: BundleManifest) {
  const rawImportUrl = dom5.getAttribute(linkTag, 'href')!;
  const resolvedImportUrl = urlLib.resolve(document.url, rawImportUrl);
  const importBundleUrl = manifest.bundleUrlForFile.get(resolvedImportUrl);

  // Don't reprocess the same file again.
  if (visitedUrls.has(resolvedImportUrl)) {
    astUtils.removeElementAndNewline(linkTag);
    return;
  }

  // We've never seen this import before, so we'll add it to the set to guard
  // against processing it again in the future.
  visitedUrls.add(resolvedImportUrl);

  // If we can't find a bundle for the referenced import, record that we've
  // processed it, but don't remove the import link.  Browser will handle it.
  if (!importBundleUrl) {
    return;
  }

  // Don't inline an import into itself.
  if (document.url === resolvedImportUrl) {
    astUtils.removeElementAndNewline(linkTag);
    return;
  }

  // If the html import refers to a file which is bundled and has a different
  // url, then lets just rewrite the href to point to the bundle url.
  if (importBundleUrl !== docBundle.url) {
    // If we've previously visited a url that is part of another bundle, it
    // means we've handled that entire bundle, so we guard against inlining any
    // other file from that bundle by checking the visited urls for the bundle
    // url itself.
    if (visitedUrls.has(importBundleUrl)) {
      astUtils.removeElementAndNewline(linkTag);
      return;
    }

    const relative =
        urlUtils.relativeUrl(document.url, importBundleUrl) || importBundleUrl;
    dom5.setAttribute(linkTag, 'href', relative);
    visitedUrls.add(importBundleUrl);
    return;
  }

  // If the analyzer could not load the import document, we can't inline it, so
  // lets skip it.
  const htmlImport = findInSet(
      document.getByKind('html-import', {imported: true}),
      (i) => i.url === resolvedImportUrl);
  if (!htmlImport) {
    return;
  }

  // When inlining html documents, we'll parse it as a fragment so that we do
  // not get html, head or body wrappers.
  const importAst =
      parse5.parseFragment(htmlImport.document.parsedDocument.contents);
  rewriteAstToEmulateBaseTag(importAst, resolvedImportUrl);
  rewriteAstBaseUrl(importAst, resolvedImportUrl, document.url);
  const nestedImports = dom5.queryAll(importAst, matchers.htmlImport);

  // Move all of the import doc content after the html import.
  astUtils.insertAllBefore(linkTag.parentNode!, linkTag, importAst.childNodes!);
  astUtils.removeElementAndNewline(linkTag);

  // Recursively process the nested imports.
  for (const nestedImport of nestedImports) {
    await inlineHtmlImport(
        document, nestedImport, visitedUrls, docBundle, manifest);
  }
}

/**
 * Inlines the contents of the document returned by the script tag's src url
 * into the script tag content and removes the src attribute.
 */
export async function inlineScript(document: Document, scriptTag: ASTNode) {
  const rawImportUrl = dom5.getAttribute(scriptTag, 'src')!;
  const resolvedImportUrl = urlLib.resolve(document.url, rawImportUrl);
  const scriptImport = findInSet(
      document.getByKind('html-script', {imported: true}),
      (i) => i.url === resolvedImportUrl);
  if (!scriptImport) {
    return;
  }

  // Second argument 'true' tells encodeString to escape <script> tags.
  const scriptContent =
      encodeString(scriptImport.document.parsedDocument.contents, true);
  dom5.removeAttribute(scriptTag, 'src');
  dom5.setTextContent(scriptTag, scriptContent);
  return scriptContent;
}

/**
 * Inlines the contents of the stylesheet returned by the link tag's href url
 * into a style tag and removes the link tag.
 */
export async function inlineStylesheet(document: Document, cssLink: ASTNode) {
  const stylesheetUrl = dom5.getAttribute(cssLink, 'href')!;
  const resolvedImportUrl = urlLib.resolve(document.url, stylesheetUrl);
  const stylesheetImport =  // HACK(usergenic): clang-format workaround
      findInSet(
          document.getByKind('html-style', {imported: true}),
          (i) => i.url === resolvedImportUrl) ||
      findInSet(
          document.getByKind('css-import', {imported: true}),
          (i) => i.url === resolvedImportUrl);
  if (!stylesheetImport) {
    return;
  }
  const stylesheetContent = stylesheetImport.document.parsedDocument.contents;
  const media = dom5.getAttribute(cssLink, 'media');
  const resolvedStylesheetContent =
      rewriteCssTextBaseUrl(stylesheetContent, resolvedImportUrl, document.url);
  const styleNode = dom5.constructors.element('style');

  if (media) {
    dom5.setAttribute(styleNode, 'media', media);
  }

  dom5.replace(cssLink, styleNode);
  dom5.setTextContent(styleNode, resolvedStylesheetContent);
  return styleNode;
}

/**
 * Given an import document with a base tag, transform all of its URLs and set
 * link and form target attributes and remove the base tag.
 */
export function rewriteAstToEmulateBaseTag(ast: ASTNode, docUrl: UrlString) {
  const baseTag = dom5.query(ast, matchers.base);
  const p = dom5.predicates;
  // If there's no base tag, there's nothing to do.
  if (!baseTag) {
    return;
  }
  for (const baseTag of dom5.queryAll(ast, matchers.base)) {
    astUtils.removeElementAndNewline(baseTag);
  }
  if (dom5.predicates.hasAttr('href')(baseTag)) {
    const baseUrl = urlLib.resolve(docUrl, dom5.getAttribute(baseTag, 'href')!);
    rewriteAstBaseUrl(ast, baseUrl, docUrl);
  }
  if (p.hasAttr('target')(baseTag)) {
    const baseTarget = dom5.getAttribute(baseTag, 'target')!;
    const tagsToTarget = dom5.queryAll(
        ast,
        p.AND(
            p.OR(p.hasTagName('a'), p.hasTagName('form')),
            p.NOT(p.hasAttr('target'))));
    for (const tag of tagsToTarget) {
      dom5.setAttribute(tag, 'target', baseTarget);
    }
  }
}

/**
 * Walk through an import document, and rewrite all urls so they are
 * correctly relative to the main document url as they've been
 * imported from the import url.
 */
export function rewriteAstBaseUrl(
    ast: ASTNode, oldBaseUrl: UrlString, newBaseUrl: UrlString) {
  rewriteElementAttrsBaseUrl(ast, oldBaseUrl, newBaseUrl);
  rewriteStyleTagsBaseUrl(ast, oldBaseUrl, newBaseUrl);
  setDomModuleAssetpaths(ast, oldBaseUrl, newBaseUrl);
}

/**
 * Simple utility function used to find an item in a set with a predicate
 * function.  Analagous to Array.find(), without requiring converting the set
 * an Array.
 */
function findInSet<T>(set: Set<T>, predicate: (item: T) => boolean): T|
    undefined {
  for (const item of set) {
    if (predicate(item)) {
      return item;
    }
  }
  return;
}

/**
 * Given a string of CSS, return a version where all occurrences of urls,
 * have been rewritten based on the relationship of the old base url to the
 * new base url.
 */
function rewriteCssTextBaseUrl(
    cssText: string, oldBaseUrl: UrlString, newBaseUrl: UrlString): string {
  return cssText.replace(constants.URL, (match) => {
    let path = match.replace(/["']/g, '').slice(4, -1);
    path = urlUtils.rewriteHrefBaseUrl(path, oldBaseUrl, newBaseUrl);
    return 'url("' + path + '")';
  });
}

/**
 * Find all element attributes which express urls and rewrite them so they
 * are based on the relationship of the old base url to the new base url.
 */
function rewriteElementAttrsBaseUrl(
    ast: ASTNode, oldBaseUrl: UrlString, newBaseUrl: UrlString) {
  const nodes = dom5.queryAll(
      ast, matchers.urlAttrs, undefined, dom5.childNodesIncludeTemplate);
  for (const node of nodes) {
    for (const attr of constants.URL_ATTR) {
      const attrValue = dom5.getAttribute(node, attr);
      if (attrValue && !urlUtils.isTemplatedUrl(attrValue)) {
        let relUrl: UrlString;
        if (attr === 'style') {
          relUrl = rewriteCssTextBaseUrl(attrValue, oldBaseUrl, newBaseUrl);
        } else {
          relUrl =
              urlUtils.rewriteHrefBaseUrl(attrValue, oldBaseUrl, newBaseUrl);
        }
        dom5.setAttribute(node, attr, relUrl);
      }
    }
  }
}

/**
 * Find all urls in imported style nodes and rewrite them so they are based
 * on the relationship of the old base url to the new base url.
 */
function rewriteStyleTagsBaseUrl(
    ast: ASTNode, oldBaseUrl: UrlString, newBaseUrl: UrlString) {
  const styleNodes = dom5.queryAll(
      ast, matchers.styleMatcher, undefined, dom5.childNodesIncludeTemplate);
  for (const node of styleNodes) {
    let styleText = dom5.getTextContent(node);
    styleText = rewriteCssTextBaseUrl(styleText, oldBaseUrl, newBaseUrl);
    dom5.setTextContent(node, styleText);
  }
}

/**
 * Set the assetpath attribute of all imported dom-modules which don't yet
 * have them if the base urls are different.
 */
function setDomModuleAssetpaths(
    ast: ASTNode, oldBaseUrl: UrlString, newBaseUrl: UrlString) {
  const domModules = dom5.queryAll(ast, matchers.domModuleWithoutAssetpath);
  for (let i = 0, node: ASTNode; i < domModules.length; i++) {
    node = domModules[i];
    const assetPathUrl = urlUtils.relativeUrl(
        newBaseUrl, urlUtils.stripUrlFileSearchAndHash(oldBaseUrl));

    // There's no reason to set an assetpath on a dom-module if its different
    // from the document's base.
    if (assetPathUrl !== '') {
      dom5.setAttribute(node, 'assetpath', assetPathUrl);
    }
  }
}
