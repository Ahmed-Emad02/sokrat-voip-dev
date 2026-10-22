const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

const DEPLOYMENT_SCRIPTS = [
    ['install.sh', 'install.sh'],
    ['installer-bundle/install-sokrat.sh', 'installer-bundle/install-sokrat.sh'],
    ['scripts/safe-upgrade.sh', 'scripts/safe-upgrade.sh']
];

function readScript(rel) {
    return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

test('every deployment script disables the host firewall', () => {
    for (const [label, rel] of DEPLOYMENT_SCRIPTS) {
        const content = readScript(rel);
        assert.ok(content.includes('[10z] Disabling the firewall'), `${label} has the firewall step`);
        assert.ok(content.includes('systemctl stop firewalld'), `${label} stops firewalld`);
        assert.ok(content.includes('systemctl disable firewalld'), `${label} disables firewalld`);
        assert.ok(
            content.includes('the host firewall is off - every port is exposed'),
            `${label} warns that the host is exposed`
        );
    }
});

test('the deployment scripts never leave the firewall in panic mode', () => {
    for (const [label, rel] of DEPLOYMENT_SCRIPTS) {
        const content = readScript(rel);
        assert.ok(!content.includes('firewall-cmd --panic-on'), `${label} never switches panic mode on`);
        assert.ok(content.includes('firewall-cmd --panic-off'), `${label} can take the host out of panic mode`);
    }
});

test('the legacy iptables services are stopped as well', () => {
    for (const [label, rel] of DEPLOYMENT_SCRIPTS) {
        const content = readScript(rel);
        assert.ok(content.includes('for fwsvc in iptables ip6tables'), `${label} handles the legacy services`);
        assert.ok(content.includes('systemctl stop "$fwsvc"'), `${label} stops them`);
        assert.ok(content.includes('systemctl disable "$fwsvc"'), `${label} disables them`);
    }
});

test('the firewall step sits before the services are restarted', () => {
    // On the safe-upgrade the firewall has to be off before Asterisk and the
    // app come back, so the calls of the moment are not blocked by a rule.
    const content = readScript('scripts/safe-upgrade.sh');
    const firewallAt = content.indexOf('[10z] Disabling the firewall');
    const restartAt = content.indexOf('systemctl restart asterisk');
    assert.ok(firewallAt > 0, 'the firewall step exists');
    assert.ok(restartAt > 0, 'the services are restarted');
    assert.ok(firewallAt < restartAt, 'the firewall is off before the services come back');
});

test('the offline bundle still opens the Issabel ports', () => {
    const content = readScript('installer-bundle/setup-issabel-asterisk.sh');
    assert.ok(content.includes('firewall-cmd --zone=public --add-service=http'), 'http is opened');
    assert.ok(content.includes('--add-port=5060/udp'), 'the SIP port is opened');
    assert.ok(content.includes('--add-port=10000-20000/udp'), 'the RTP range is opened');
});
