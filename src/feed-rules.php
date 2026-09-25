<?php
declare(strict_types=1);

/**
 * Platform rules: map a page URL to the platform's own (native) feed URL
 * before the page itself is fetched. Profile/landing pages of large platforms
 * often sit behind bot protection (HTTP 403), their feed endpoints usually don't.
 *
 * One-off snapshot (2026-09-25). URL patterns were written from the platforms'
 * public feed conventions and cross-checked against the site lists of
 * get-rss-feed-url-extension (shevabam, MIT) and RSSHub Radar (DIYgod, AGPL-3.0;
 * consulted only, no rules copied). Only native feeds – no third-party bridges.
 *
 * Extend here, or add src/feed-rules.local.php (same format, gitignored, checked first).
 * Run `php tests/feed-rules-test.php` after every change.
 *
 * Rule keys
 *   id       unique, kebab-case (returned as source.rule)
 *   hosts    exact hosts ("medium.com") or wildcard subdomains ("*.medium.com", excludes the bare host).
 *            The input host is compared without a leading "www.", "m." or "mobile.".
 *   except   optional: hosts to skip even if "hosts" matches
 *   match    regex against path + "?query" (path is "/" if empty); first matching rule wins
 *   feeds    feed URL templates, probed in order. Placeholders: {1}…{9} regex groups,
 *            {host} input host (lower case, unstripped), {origin} scheme://host[:port], {sub} wildcard part
 *   lookup   optional: ['url' => template, 'field' => 'dot.path'] – JSON endpoint that returns the feed URL
 *   none     optional: message – the platform offers no feeds; the Collector stops without probing
 *   examples input URL => expected first feed URL ("!none" for none rules, lookup URL for lookup rules)
 *
 * Page URLs without a rule still go through discovery (<link rel="alternate">), e.g. YouTube @handles,
 * Mastodon instances not listed below, Substack/Ghost/WordPress on custom domains.
 */

// Path segments that are app routes, not user/project names.
$githubReserved = '(?!(?:about|apps|codespaces|collections|contact|customer-stories|enterprise|events|explore|features|login|marketplace|new|notifications|orgs|organizations|pricing|pulls|issues|readme|search|security|settings|signup|sponsors|topics|trending)(?:/|\?|$))';

$mastodonHosts = [
    'mastodon.social', 'mastodon.online', 'mastodon.world', 'mas.to', 'mstdn.social', 'fosstodon.org',
    'hachyderm.io', 'infosec.exchange', 'techhub.social', 'sigmoid.social', 'mastodon.art',
    'chaos.social', 'social.tchncs.de', 'norden.social', 'troet.cafe', 'det.social', 'mastodon.de',
];

return [

    // ================================================================ Blogs & publishing

    [
        'id' => 'medium-user',
        'hosts' => ['medium.com'],
        'match' => '#^/@([\w.-]+)#',
        'feeds' => ['https://medium.com/feed/@{1}'],
        'examples' => [
            'https://medium.com/@vignarajj' => 'https://medium.com/feed/@vignarajj',
            'https://medium.com/@vignarajj/some-article-1a2b3c' => 'https://medium.com/feed/@vignarajj',
        ],
    ],
    [
        'id' => 'medium-tag',
        'hosts' => ['medium.com'],
        'match' => '#^/(?:tag|tags)/([\w-]+)#',
        'feeds' => ['https://medium.com/feed/tag/{1}'],
        'examples' => ['https://medium.com/tag/green-software/latest' => 'https://medium.com/feed/tag/green-software'],
    ],
    [
        'id' => 'medium-publication',
        'hosts' => ['medium.com'],
        'match' => '#^/(?!(?:feed|tag|tags|topic|topics|p|m|me|search|plans|membership|about|creators|policy|sitemap|new-story|_)(?:/|\?|$))([a-z0-9][\w-]*)(?:/|\?|$)#i',
        'feeds' => ['https://medium.com/feed/{1}'],
        'examples' => [
            'https://medium.com/better-programming' => 'https://medium.com/feed/better-programming',
            'https://medium.com/better-programming/an-article-123' => 'https://medium.com/feed/better-programming',
        ],
    ],
    [
        'id' => 'medium-subdomain',
        'hosts' => ['*.medium.com'],
        'except' => ['help.medium.com', 'policy.medium.com', 'blog.medium.com', 'cdn-images-1.medium.com', 'miro.medium.com'],
        'match' => '#^/#',
        'feeds' => ['https://{host}/feed'],
        'examples' => ['https://someone.medium.com/' => 'https://someone.medium.com/feed'],
    ],
    [
        'id' => 'substack',
        'hosts' => ['*.substack.com'],
        'match' => '#^/#',
        'feeds' => ['https://{host}/feed'],
        'examples' => ['https://example.substack.com/p/some-post' => 'https://example.substack.com/feed'],
    ],
    [
        'id' => 'hashnode',
        'hosts' => ['*.hashnode.dev'],
        'match' => '#^/#',
        'feeds' => ['https://{host}/rss.xml'],
        'examples' => ['https://someone.hashnode.dev/' => 'https://someone.hashnode.dev/rss.xml'],
    ],
    [
        'id' => 'wordpress-com-archive',
        'hosts' => ['*.wordpress.com'],
        'match' => '#^/(category|tag)/([^?\#]+?)/?(?:\?|$)#',
        'feeds' => ['https://{host}/{1}/{2}/feed/'],
        'examples' => ['https://example.wordpress.com/category/news/' => 'https://example.wordpress.com/category/news/feed/'],
    ],
    [
        'id' => 'wordpress-com',
        'hosts' => ['*.wordpress.com'],
        'except' => ['public-api.wordpress.com', 'developer.wordpress.com', 'subscribe.wordpress.com'],
        'match' => '#^/#',
        'feeds' => ['https://{host}/feed/'],
        'examples' => ['https://example.wordpress.com/2026/09/01/post/' => 'https://example.wordpress.com/feed/'],
    ],
    [
        'id' => 'blogger-label',
        'hosts' => ['*.blogspot.com'],
        'match' => '#^/search/label/([^/?\#]+)#',
        'feeds' => ['https://{host}/feeds/posts/default/-/{1}'],
        'examples' => ['https://example.blogspot.com/search/label/News' => 'https://example.blogspot.com/feeds/posts/default/-/News'],
    ],
    [
        'id' => 'blogger',
        'hosts' => ['*.blogspot.com'],
        'match' => '#^/#',
        'feeds' => ['https://{host}/feeds/posts/default'],
        'examples' => ['https://example.blogspot.com/' => 'https://example.blogspot.com/feeds/posts/default'],
    ],
    [
        'id' => 'tumblr-subdomain',
        'hosts' => ['*.tumblr.com'],
        'except' => ['api.tumblr.com', 'help.tumblr.com', 'assets.tumblr.com'],
        'match' => '#^/#',
        'feeds' => ['https://{host}/rss'],
        'examples' => ['https://staff.tumblr.com/' => 'https://staff.tumblr.com/rss'],
    ],
    [
        'id' => 'tumblr-blog',
        'hosts' => ['tumblr.com'],
        'match' => '#^/(?!(?:dashboard|explore|login|register|search|settings|tagged|blog|likes|following|inbox|help|about|policy|privacy|apps)(?:/|\?|$))([a-z0-9-]+)/?(?:\?|$)#i',
        'feeds' => ['https://{1}.tumblr.com/rss'],
        'examples' => ['https://www.tumblr.com/staff' => 'https://staff.tumblr.com/rss'],
    ],
    [
        'id' => 'devto-tag',
        'hosts' => ['dev.to'],
        'match' => '#^/t/([\w-]+)#',
        'feeds' => ['https://dev.to/feed/tag/{1}'],
        'examples' => ['https://dev.to/t/php' => 'https://dev.to/feed/tag/php'],
    ],
    [
        'id' => 'devto-home',
        'hosts' => ['dev.to'],
        'match' => '#^/?(?:\?|$)#',
        'feeds' => ['https://dev.to/feed'],
        'examples' => ['https://dev.to/' => 'https://dev.to/feed'],
    ],
    [
        'id' => 'devto-user',
        'hosts' => ['dev.to'],
        'match' => '#^/(?!(?:feed|t|search|top|latest|tags|about|settings|enter|signout_confirm|videos|listings|podcasts|faq)(?:/|\?|$))([\w-]+)(?:/|\?|$)#',
        'feeds' => ['https://dev.to/feed/{1}'],
        'examples' => ['https://dev.to/ben' => 'https://dev.to/feed/ben', 'https://dev.to/ben/some-post-1abc' => 'https://dev.to/feed/ben'],
    ],
    [
        'id' => 'mirror-xyz',
        'hosts' => ['mirror.xyz'],
        'match' => '#^/([\w.-]+)/?(?:\?|$)#',
        'feeds' => ['https://mirror.xyz/{1}/feed/atom'],
        'examples' => ['https://mirror.xyz/someone.eth' => 'https://mirror.xyz/someone.eth/feed/atom'],
    ],
    [
        'id' => 'huggingface-blog',
        'hosts' => ['huggingface.co'],
        'match' => '#^/blog(?:/|\?|$)#',
        'feeds' => ['https://huggingface.co/blog/feed.xml'],
        'examples' => ['https://huggingface.co/blog' => 'https://huggingface.co/blog/feed.xml'],
    ],

    // ================================================================ Video & audio

    [
        'id' => 'youtube-channel',
        'hosts' => ['youtube.com'],
        'match' => '#^/channel/(UC[\w-]{22})#',
        'feeds' => ['https://www.youtube.com/feeds/videos.xml?channel_id={1}'],
        'examples' => ['https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ/videos' => 'https://www.youtube.com/feeds/videos.xml?channel_id=UCBJycsmduvYEL83R_U4JriQ'],
    ],
    [
        'id' => 'youtube-playlist',
        'hosts' => ['youtube.com'],
        'match' => '#^/(?:playlist|watch)\?(?:.*&)?list=([\w-]+)#',
        'feeds' => ['https://www.youtube.com/feeds/videos.xml?playlist_id={1}'],
        'examples' => [
            'https://www.youtube.com/playlist?list=PLabc123' => 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabc123',
            'https://m.youtube.com/watch?v=xyz&list=PLabc123' => 'https://www.youtube.com/feeds/videos.xml?playlist_id=PLabc123',
        ],
    ],
    [
        'id' => 'youtube-user',
        'hosts' => ['youtube.com'],
        'match' => '#^/user/([\w-]+)#',
        'feeds' => ['https://www.youtube.com/feeds/videos.xml?user={1}'],
        'examples' => ['https://www.youtube.com/user/GoogleDevelopers' => 'https://www.youtube.com/feeds/videos.xml?user=GoogleDevelopers'],
    ],
    // YouTube /@handle and /c/name: no rule – the page declares its feed (discovery).
    [
        'id' => 'vimeo-channel',
        'hosts' => ['vimeo.com'],
        'match' => '#^/channels/([\w-]+)#',
        'feeds' => ['https://vimeo.com/channels/{1}/videos/rss'],
        'examples' => ['https://vimeo.com/channels/staffpicks' => 'https://vimeo.com/channels/staffpicks/videos/rss'],
    ],
    [
        'id' => 'vimeo-user',
        'hosts' => ['vimeo.com'],
        'match' => '#^/(?!(?:channels|groups|categories|watch|search|features|upload|log_in|login|join|blog|help|ondemand|showcase|manage|settings|stock|solutions|enterprise|create|live|about|jobs|partners|site_map)(?:/|\?|$))([a-z][\w-]*)/?(?:\?|$)#i',
        'feeds' => ['https://vimeo.com/{1}/videos/rss'],
        'examples' => ['https://vimeo.com/someuser' => 'https://vimeo.com/someuser/videos/rss'],
    ],
    [
        'id' => 'apple-podcasts',
        'hosts' => ['podcasts.apple.com', 'itunes.apple.com'],
        'match' => '#/id(\d+)#',
        'feeds' => [],
        'lookup' => ['url' => 'https://itunes.apple.com/lookup?id={1}&entity=podcast', 'field' => 'results.0.feedUrl'],
        'examples' => ['https://podcasts.apple.com/de/podcast/some-show/id1234567890' => 'https://itunes.apple.com/lookup?id=1234567890&entity=podcast'],
    ],

    // ================================================================ Social & communities

    [
        'id' => 'reddit-home',
        'hosts' => ['reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com'],
        'match' => '#^/?(?:\?|$)#',
        'feeds' => ['https://www.reddit.com/.rss'],
        'examples' => ['https://www.reddit.com/' => 'https://www.reddit.com/.rss'],
    ],
    [
        'id' => 'reddit-u',
        'hosts' => ['reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com'],
        'match' => '#^/u/([\w-]+)#',
        'feeds' => ['https://www.reddit.com/user/{1}/.rss'],
        'examples' => ['https://www.reddit.com/u/spez' => 'https://www.reddit.com/user/spez/.rss'],
    ],
    [
        'id' => 'reddit',
        'hosts' => ['reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com'],
        'match' => '#^(?![^?]*\.rss)(/(?:r|user)/[^?\#]*?)/?(?:\?.*)?$#',
        'feeds' => ['https://www.reddit.com{1}/.rss'],
        'examples' => [
            'https://www.reddit.com/r/selfhosted/' => 'https://www.reddit.com/r/selfhosted/.rss',
            'https://old.reddit.com/r/rss/new/' => 'https://www.reddit.com/r/rss/new/.rss',
            'https://www.reddit.com/r/rss/comments/abc123/some_title/' => 'https://www.reddit.com/r/rss/comments/abc123/some_title/.rss',
            'https://www.reddit.com/user/spez' => 'https://www.reddit.com/user/spez/.rss',
        ],
    ],
    [
        'id' => 'mastodon-remote-account',
        'hosts' => $mastodonHosts,
        'match' => '#^/@(\w+)@([\w.-]+\.[a-z]{2,})/?(?:\?|$)#i',
        'feeds' => ['https://{2}/@{1}.rss'],
        'examples' => ['https://mastodon.social/@someone@chaos.social' => 'https://chaos.social/@someone.rss'],
    ],
    [
        'id' => 'mastodon-account',
        'hosts' => $mastodonHosts,
        'match' => '#^/@(\w+)(?:/(?:with_replies|media))?/?(?:\?|$)#',
        'feeds' => ['https://{host}/@{1}.rss'],
        'examples' => ['https://mastodon.social/@Gargron' => 'https://mastodon.social/@Gargron.rss'],
    ],
    [
        'id' => 'mastodon-tag',
        'hosts' => $mastodonHosts,
        'match' => '#^/tags/(\w+)/?(?:\?|$)#',
        'feeds' => ['https://{host}/tags/{1}.rss'],
        'examples' => ['https://fosstodon.org/tags/rss' => 'https://fosstodon.org/tags/rss.rss'],
    ],
    [
        'id' => 'bluesky-profile',
        'hosts' => ['bsky.app'],
        'match' => '#^/profile/([^/?\#]+)/?(?:\?|$)#',
        'feeds' => ['https://bsky.app/profile/{1}/rss'],
        'examples' => ['https://bsky.app/profile/bsky.app' => 'https://bsky.app/profile/bsky.app/rss'],
    ],
    [
        'id' => 'hackernews',
        'hosts' => ['news.ycombinator.com'],
        'match' => '#^/(?:news|front)?/?(?:\?|$)#',
        'feeds' => ['https://news.ycombinator.com/rss'],
        'examples' => ['https://news.ycombinator.com/' => 'https://news.ycombinator.com/rss'],
    ],
    [
        'id' => 'lobsters-tag',
        'hosts' => ['lobste.rs'],
        'match' => '#^/t/([\w,-]+)/?(?:\?|$)#',
        'feeds' => ['https://lobste.rs/t/{1}.rss'],
        'examples' => ['https://lobste.rs/t/web' => 'https://lobste.rs/t/web.rss'],
    ],
    [
        'id' => 'lobsters-newest',
        'hosts' => ['lobste.rs'],
        'match' => '#^/newest/?(?:\?|$)#',
        'feeds' => ['https://lobste.rs/newest.rss'],
        'examples' => ['https://lobste.rs/newest' => 'https://lobste.rs/newest.rss'],
    ],
    [
        'id' => 'lobsters-home',
        'hosts' => ['lobste.rs'],
        'match' => '#^/?(?:\?|$)#',
        'feeds' => ['https://lobste.rs/rss'],
        'examples' => ['https://lobste.rs/' => 'https://lobste.rs/rss'],
    ],
    [
        'id' => 'stackexchange-tag',
        'hosts' => ['stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net', '*.stackexchange.com'],
        'match' => '#^/questions/tagged/([^/?\#]+)#',
        'feeds' => ['https://{host}/feeds/tag/{1}'],
        'examples' => ['https://stackoverflow.com/questions/tagged/php' => 'https://stackoverflow.com/feeds/tag/php'],
    ],
    [
        'id' => 'stackexchange-question',
        'hosts' => ['stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net', '*.stackexchange.com'],
        'match' => '#^/questions/(\d+)#',
        'feeds' => ['https://{host}/feeds/question/{1}'],
        'examples' => ['https://unix.stackexchange.com/questions/12345/title' => 'https://unix.stackexchange.com/feeds/question/12345'],
    ],
    [
        'id' => 'stackexchange-user',
        'hosts' => ['stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net', '*.stackexchange.com'],
        'match' => '#^/users/(\d+)#',
        'feeds' => ['https://{host}/feeds/user/{1}'],
        'examples' => ['https://stackoverflow.com/users/22656/jon-skeet' => 'https://stackoverflow.com/feeds/user/22656'],
    ],
    [
        'id' => 'pinterest-board',
        'hosts' => ['pinterest.com', '*.pinterest.com', 'pinterest.de'],
        'match' => '#^/(?!(?:pin|search|ideas|today|business|login|settings|_)(?:/|\?|$))([\w.-]+)/([\w.-]+)/?(?:\?|$)#',
        'feeds' => ['https://www.pinterest.com/{1}/{2}.rss'],
        'examples' => ['https://www.pinterest.com/someone/recipes/' => 'https://www.pinterest.com/someone/recipes.rss'],
    ],
    [
        'id' => 'pinterest-user',
        'hosts' => ['pinterest.com', '*.pinterest.com', 'pinterest.de'],
        'match' => '#^/(?!(?:pin|search|ideas|today|business|login|settings|_)(?:/|\?|$))([\w.-]+)/?(?:\?|$)#',
        'feeds' => ['https://www.pinterest.com/{1}/feed.rss'],
        'examples' => ['https://de.pinterest.com/someone/' => 'https://www.pinterest.com/someone/feed.rss'],
    ],
    [
        'id' => 'letterboxd-user',
        'hosts' => ['letterboxd.com'],
        'match' => '#^/(?!(?:film|films|lists|members|journal|search|activity|settings|sign-in|create-account|about|pro|apps|legal|contact|showdown|reviews|tag)(?:/|\?|$))(\w+)/?(?:\?|$)#',
        'feeds' => ['https://letterboxd.com/{1}/rss/'],
        'examples' => ['https://letterboxd.com/someone/' => 'https://letterboxd.com/someone/rss/'],
    ],

    // ================================================================ Code & packages

    [
        'id' => 'github-releases',
        'hosts' => ['github.com'],
        'match' => '#^/' . $githubReserved . '([\w.-]+)/([\w.-]+)/releases(?:/|\?|$)#',
        'feeds' => ['https://github.com/{1}/{2}/releases.atom'],
        'examples' => ['https://github.com/php/php-src/releases' => 'https://github.com/php/php-src/releases.atom'],
    ],
    [
        'id' => 'github-tags',
        'hosts' => ['github.com'],
        'match' => '#^/' . $githubReserved . '([\w.-]+)/([\w.-]+)/tags(?:/|\?|$)#',
        'feeds' => ['https://github.com/{1}/{2}/tags.atom'],
        'examples' => ['https://github.com/php/php-src/tags' => 'https://github.com/php/php-src/tags.atom'],
    ],
    [
        'id' => 'github-commits-branch',
        'hosts' => ['github.com'],
        'match' => '#^/' . $githubReserved . '([\w.-]+)/([\w.-]+)/commits/([^?\#]+?)/?(?:\?|$)#',
        'feeds' => ['https://github.com/{1}/{2}/commits/{3}.atom'],
        'examples' => ['https://github.com/php/php-src/commits/master' => 'https://github.com/php/php-src/commits/master.atom'],
    ],
    [
        'id' => 'github-commits',
        'hosts' => ['github.com'],
        'match' => '#^/' . $githubReserved . '([\w.-]+)/([\w.-]+)/commits/?(?:\?|$)#',
        'feeds' => ['https://github.com/{1}/{2}/commits.atom'],
        'examples' => ['https://github.com/php/php-src/commits' => 'https://github.com/php/php-src/commits.atom'],
    ],
    [
        'id' => 'github-repo',
        'hosts' => ['github.com'],
        'match' => '#^/' . $githubReserved . '([\w.-]+)/([\w.-]+?)(?:\.git)?/?(?:\?|$)#',
        'feeds' => ['https://github.com/{1}/{2}/releases.atom', 'https://github.com/{1}/{2}/commits.atom'],
        'examples' => ['https://github.com/kreativ-anders/news-reader' => 'https://github.com/kreativ-anders/news-reader/releases.atom'],
    ],
    [
        'id' => 'github-user',
        'hosts' => ['github.com'],
        'match' => '#^/' . $githubReserved . '([\w-]+)/?(?:\?|$)#',
        'feeds' => ['https://github.com/{1}.atom'],
        'examples' => ['https://github.com/kreativ-anders' => 'https://github.com/kreativ-anders.atom'],
    ],
    [
        'id' => 'gitlab-tags',
        'hosts' => ['gitlab.com'],
        'match' => '#^/([\w.-]+(?:/[\w.-]+)+?)/-/tags(?:/|\?|$)#',
        'feeds' => ['https://gitlab.com/{1}/-/tags?format=atom'],
        'examples' => ['https://gitlab.com/gitlab-org/gitlab/-/tags' => 'https://gitlab.com/gitlab-org/gitlab/-/tags?format=atom'],
    ],
    [
        'id' => 'gitlab-commits',
        'hosts' => ['gitlab.com'],
        'match' => '#^/([\w.-]+(?:/[\w.-]+)+?)/-/commits/([^?\#]+?)/?(?:\?|$)#',
        'feeds' => ['https://gitlab.com/{1}/-/commits/{2}?format=atom'],
        'examples' => ['https://gitlab.com/gitlab-org/gitlab/-/commits/master' => 'https://gitlab.com/gitlab-org/gitlab/-/commits/master?format=atom'],
    ],
    [
        'id' => 'gitlab-repo',
        'hosts' => ['gitlab.com'],
        'match' => '#^/(?!(?:explore|users|dashboard|help|search|groups|-)(?:/|\?|$))([\w.-]+/[\w.-]+)/?(?:\?|$)#',
        'feeds' => ['https://gitlab.com/{1}/-/tags?format=atom'],
        'examples' => ['https://gitlab.com/gitlab-org/gitlab' => 'https://gitlab.com/gitlab-org/gitlab/-/tags?format=atom'],
    ],
    [
        'id' => 'codeberg-releases',
        'hosts' => ['codeberg.org'],
        'match' => '#^/([\w.-]+)/([\w.-]+)/releases(?:/|\?|$)#',
        'feeds' => ['https://codeberg.org/{1}/{2}/releases.rss'],
        'examples' => ['https://codeberg.org/forgejo/forgejo/releases' => 'https://codeberg.org/forgejo/forgejo/releases.rss'],
    ],
    [
        'id' => 'codeberg-repo',
        'hosts' => ['codeberg.org'],
        'match' => '#^/(?!(?:explore|user|repo|org|api|assets)(?:/|\?|$))([\w.-]+)/([\w.-]+?)/?(?:\?|$)#',
        'feeds' => ['https://codeberg.org/{1}/{2}/releases.rss', 'https://codeberg.org/{1}/{2}.rss'],
        'examples' => ['https://codeberg.org/forgejo/forgejo' => 'https://codeberg.org/forgejo/forgejo/releases.rss'],
    ],
    [
        'id' => 'codeberg-user',
        'hosts' => ['codeberg.org'],
        'match' => '#^/(?!(?:explore|user|repo|org|api|assets)(?:/|\?|$))([\w.-]+)/?(?:\?|$)#',
        'feeds' => ['https://codeberg.org/{1}.rss'],
        'examples' => ['https://codeberg.org/forgejo' => 'https://codeberg.org/forgejo.rss'],
    ],
    [
        'id' => 'pypi-project',
        'hosts' => ['pypi.org'],
        'match' => '#^/project/([\w.-]+)#',
        'feeds' => ['https://pypi.org/rss/project/{1}/releases.xml'],
        'examples' => ['https://pypi.org/project/requests/' => 'https://pypi.org/rss/project/requests/releases.xml'],
    ],
    [
        'id' => 'rubygems',
        'hosts' => ['rubygems.org'],
        'match' => '#^/gems/([\w.-]+)#',
        'feeds' => ['https://rubygems.org/gems/{1}/versions.atom'],
        'examples' => ['https://rubygems.org/gems/rails' => 'https://rubygems.org/gems/rails/versions.atom'],
    ],

    // ================================================================ Other

    [
        'id' => 'arxiv-list',
        'hosts' => ['arxiv.org'],
        'match' => '#^/list/([\w.-]+?)(?:/[\w]+)?/?(?:\?|$)#',
        'feeds' => ['https://rss.arxiv.org/rss/{1}'],
        'examples' => ['https://arxiv.org/list/cs.SE/recent' => 'https://rss.arxiv.org/rss/cs.SE'],
    ],
    [
        'id' => 'google-news',
        'hosts' => ['news.google.com'],
        'match' => '#^/(?!rss/)((?:topics|stories)/[^?\#]+|search)(\?[^\#]*)?$#',
        'feeds' => ['https://news.google.com/rss/{1}{2}'],
        'examples' => ['https://news.google.com/search?q=rss&hl=de' => 'https://news.google.com/rss/search?q=rss&hl=de'],
    ],
    [
        'id' => 'steam-app',
        'hosts' => ['store.steampowered.com'],
        'match' => '#^/app/(\d+)#',
        'feeds' => ['https://store.steampowered.com/feeds/news/app/{1}/'],
        'examples' => ['https://store.steampowered.com/app/620/Portal_2/' => 'https://store.steampowered.com/feeds/news/app/620/'],
    ],
    [
        'id' => 'kickstarter-project',
        'hosts' => ['kickstarter.com'],
        'match' => '#^/projects/([\w-]+)/([\w-]+)#',
        'feeds' => ['https://www.kickstarter.com/projects/{1}/{2}/posts.atom'],
        'examples' => ['https://www.kickstarter.com/projects/someone/some-project' => 'https://www.kickstarter.com/projects/someone/some-project/posts.atom'],
    ],
    [
        'id' => 'itchio-browse',
        'hosts' => ['itch.io'],
        'match' => '#^/((?:games|tools|game-assets|physical-games|soundtracks|comics|books|misc)(?:/[\w-]+)*)/?(?:\?|$)#',
        'feeds' => ['https://itch.io/{1}.xml'],
        'examples' => ['https://itch.io/games/new-and-popular' => 'https://itch.io/games/new-and-popular.xml'],
    ],
    [
        'id' => 'producthunt',
        'hosts' => ['producthunt.com'],
        'match' => '#^/?(?:\?|$)#',
        'feeds' => ['https://www.producthunt.com/feed'],
        'examples' => ['https://www.producthunt.com/' => 'https://www.producthunt.com/feed'],
    ],

    // ================================================================ Platforms without feeds

    [
        'id' => 'x-twitter',
        'hosts' => ['x.com', 'twitter.com'],
        'match' => '#^/#',
        'none' => 'X/Twitter does not offer RSS feeds.',
        'examples' => ['https://x.com/someone' => '!none'],
    ],
    [
        'id' => 'meta',
        'hosts' => ['facebook.com', 'instagram.com', 'threads.net', 'threads.com'],
        'match' => '#^/#',
        'none' => 'Facebook, Instagram and Threads do not offer RSS feeds.',
        'examples' => ['https://www.instagram.com/someone/' => '!none'],
    ],
    [
        'id' => 'linkedin',
        'hosts' => ['linkedin.com'],
        'match' => '#^/#',
        'none' => 'LinkedIn does not offer RSS feeds.',
        'examples' => ['https://www.linkedin.com/in/someone/' => '!none'],
    ],
    [
        'id' => 'tiktok',
        'hosts' => ['tiktok.com'],
        'match' => '#^/#',
        'none' => 'TikTok does not offer RSS feeds.',
        'examples' => ['https://www.tiktok.com/@someone' => '!none'],
    ],
    [
        'id' => 'spotify',
        'hosts' => ['open.spotify.com'],
        'match' => '#^/#',
        'none' => 'Spotify does not expose feeds. For podcasts, use the show\'s Apple Podcasts link or its website.',
        'examples' => ['https://open.spotify.com/show/abc' => '!none'],
    ],
];
