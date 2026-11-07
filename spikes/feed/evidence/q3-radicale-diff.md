
## principal PROPFIND Depth 0 (Radicale 207, ours 207)
| property | Radicale | Supercal |
|---|---|---|
| C:calendar-home-set | 200 [/meridian/] | 200 [/dav/calendars/meridian/] |
| C:calendar-user-address-set | 200 [/meridian/] | 200 [mailto:meridian@feeds.supercal.invalid,/dav/principals/meridian/] |
| C:schedule-inbox-URL | 404 | 404 |
| C:schedule-outbox-URL | 404 | 404 |
| CS:dropbox-home-URL | 404 | 404 |
| CS:email-address-set | 404 | 404 |
| D:current-user-principal | 200 [/meridian/] | 200 [/dav/principals/meridian/] |
| D:displayname | 404 | 200 [meridian] |
| D:principal-URL | 200 [/meridian/] | 200 [/dav/principals/meridian/] |
| D:principal-collection-set | 200 [/] | 200 [/dav/principals/] |
| D:resource-id | 404 | 404 |
| D:supported-report-set | 200 [expand-property,principal-search-property-set,principal-property-searc] | 200 |

## calendar collection in home Depth 1 (Radicale 207, ours 207)
| property | Radicale | Supercal |
|---|---|---|
| A:calendar-color | 404 | 200 [#1E88E5FF] |
| A:calendar-order | 404 | 200 [0] |
| C:calendar-description | 404 | 200 [passthrough · full · read-only] |
| C:calendar-timezone | 404 | 404 |
| C:max-resource-size | 200 [10000000] | 404 |
| C:schedule-calendar-transp | 404 | 200 [opaque] |
| C:supported-calendar-component-set | 200 [comp=VTODO,comp=VEVENT,comp=VJOURNAL] | 200 [comp=VEVENT] |
| C:supported-calendar-data | 404 | 200 [calendar-data] |
| CS:getctag | 200 ["773a7a368e5120632ca2cc26eddf4be24103d8e1d3720d481ea10760946bb83c"] | 200 [http://supercal.invalid/ns/sync/1/1/6] |
| CS:push-transports | 404 | 404 |
| CS:pushkey | 404 | 404 |
| CS:source | 200 | 404 |
| CS:subscribed-strip-alarms | 404 | 404 |
| D:add-member | 404 | 404 |
| D:current-user-privilege-set | 200 [read,read-free-busy,all,write,write-properties,write-content] | 200 [read,read-current-user-privilege-set] |
| D:displayname | 200 [meridian/feedref] | 200 [Work] |
| D:owner | 200 [/meridian/] | 200 [/dav/principals/meridian/] |
| D:quota-available-bytes | 404 | 404 |
| D:quota-used-bytes | 404 | 404 |
| D:resource-id | 404 | 404 |
| D:resourcetype | 200 [calendar,collection] | 200 [collection,calendar] |
| D:supported-report-set | 200 [expand-property,principal-search-property-set,principal-property-searc] | 200 [calendar-query,calendar-multiget,sync-collection] |
| D:sync-token | 200 [http://radicale.org/ns/sync/74f278bca4eb35c61282ff1a8e55db376a1c1ef8df] | 200 [http://supercal.invalid/ns/sync/1/1/6] |
