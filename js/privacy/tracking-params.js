/**
 * Tracking query-parameter stripper — main-process only.
 *
 * Sourced from the long-running ClearURLs and Brave Browser projects,
 * trimmed to params with high confidence of being purely tracking
 * (campaign IDs, click IDs, mailer pixels). Generic names like `ref`,
 * `source`, `campaign`, `feature` are intentionally kept — too many
 * legitimate apps use them as semantic params and stripping breaks
 * navigation.
 *
 * Used by main.js's `webRequest.onBeforeRequest` mainFrame branch to
 * 302 the navigation to a clean URL, so the address bar reflects the
 * stripped form.
 */
'use strict';

const TRACKING_PARAMS = new Set([
    // Google Analytics / Ads
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'utm_id', 'utm_name', 'utm_cid', 'utm_reader', 'utm_referrer',
    'utm_pubreferrer', 'utm_swu', 'utm_viz_id', 'utm_brand',
    'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'srsltid',
    'ga_source', 'ga_medium', 'ga_term', 'ga_content', 'ga_campaign',

    // Microsoft / Bing / Yahoo
    'msclkid', 'yclid',

    // Meta / Facebook
    'fbclid', 'fb_action_ids', 'fb_action_types', 'fb_ref', 'fb_source',
    'fb_aggregation_id',

    // X / Twitter
    'twclid',

    // TikTok
    'tt_medium', 'tt_content',

    // Instagram
    'igshid', 'igsh',

    // LinkedIn
    'li_fat_id', 'trkCampaign',

    // HubSpot
    '_hsenc', '_hsmi', '__hssc', '__hstc', '__hsfp', 'hsCtaTracking',

    // Mailchimp
    'mc_cid', 'mc_eid',

    // Marketo
    'mkt_tok',

    // Vero
    'vero_id', 'vero_conv',

    // Yandex / Pinterest
    '_openstat', 'epik',

    // Adobe / Omniture
    's_kwcid', 'icid',

    // Outbrain / Taboola
    'OutbrainClickId', 'tblci',

    // Olytics
    'oly_anon_id', 'oly_enc_id',

    // Amazon affiliate
    'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m',
    'pd_rd_w', 'pd_rd_wg', 'pd_rd_r', 'ascsubtag',

    // Matomo / Piwik
    'pk_campaign', 'pk_kwd', 'piwik_campaign', 'piwik_kwd',
    'matomo_campaign', 'matomo_kwd', 'matomo_source', 'matomo_medium',
    'matomo_content',

    // Misc click trackers
    '_branch_match_id', 'cmpid', 'cmp', 'WT.mc_id', 'wtmcid',
    'sb_ref', 'spm', 'cvid', 'guce_referrer', 'guce_referrer_sig',
    'soc_src', 'soc_trk'
]);

function stripTrackingParams(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (!u.search) return rawUrl;
        let mutated = false;
        // Snapshot keys before mutation; URLSearchParams iteration during
        // delete() is unspecified.
        const keys = Array.from(u.searchParams.keys());
        for (const key of keys) {
            // Match case-insensitively — some senders capitalize.
            if (TRACKING_PARAMS.has(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
                u.searchParams.delete(key);
                mutated = true;
            }
        }
        return mutated ? u.toString() : rawUrl;
    } catch {
        return rawUrl;
    }
}

module.exports = { TRACKING_PARAMS, stripTrackingParams };
