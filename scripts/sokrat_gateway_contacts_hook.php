<?php
/**
 * Re-apply CRM gateway static AOR contacts after IssabelPBX/FreePBX regenerates
 * pjsip_additional.conf.  The state file is written by the authenticated CRM
 * integration endpoint; this hook never invents extensions.
 */
$stateFile = '/etc/asterisk/sokrat_gateway_contacts.json';
$confFile = '/etc/asterisk/pjsip_additional.conf';

if (!is_readable($stateFile) || !is_readable($confFile)) {
    return;
}

$state = json_decode(file_get_contents($stateFile), true);
$contacts = is_array($state['contacts'] ?? null) ? $state['contacts'] : [];
if ($contacts === []) {
    return;
}

$lines = file($confFile, FILE_IGNORE_NEW_LINES);
if ($lines === false) {
    return;
}

$out = [];
$count = count($lines);
$i = 0;

while ($i < $count) {
    $line = $lines[$i];

    if (preg_match('/^\s*\[([^\]]+)\]\s*$/', $line, $m)) {
        $section = $m[1];
        $sectionLines = [$line];
        $i++;

        while ($i < $count && !preg_match('/^\s*\[[^\]]+\]\s*$/', $lines[$i])) {
            $sectionLines[] = $lines[$i];
            $i++;
        }

        $isAor = false;
        foreach ($sectionLines as $sectionLine) {
            if (preg_match('/^\s*type\s*=\s*aor\s*$/i', $sectionLine)) {
                $isAor = true;
                break;
            }
        }

        $contact = $isAor && isset($contacts[$section]['contact'])
            ? trim((string) $contacts[$section]['contact'])
            : '';

        if ($contact !== '') {
            $filtered = [];
            foreach ($sectionLines as $sectionLine) {
                if (preg_match('/^\s*contact\s*=\s*(.+?)\s*$/i', $sectionLine, $cm)
                    && trim($cm[1]) === $contact) {
                    continue;
                }
                $filtered[] = $sectionLine;
            }
            $filtered[] = 'contact=' . $contact;
            $sectionLines = $filtered;
        }

        foreach ($sectionLines as $sectionLine) {
            $out[] = $sectionLine;
        }
        continue;
    }

    $out[] = $line;
    $i++;
}

file_put_contents($confFile, implode("\n", $out) . "\n");
