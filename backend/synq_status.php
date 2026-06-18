<?php
header('Content-Type: application/json');

$display_name = isset($_POST['display_name']) ? $_POST['display_name'] : '';
$status = isset($_POST['status']) ? $_POST['status'] : '';

if (empty($display_name) || empty($status)) {
    echo json_encode(["status" => "error", "message" => "Missing parameters"]);
    exit;
}

try {
    $db_user = 'root';
    $db_pass = 'admin';
    $db_host = 'localhost';
    
    if (file_exists('/etc/amportal.conf')) {
        $lines = file('/etc/amportal.conf');
        foreach ($lines as $line) {
            if (preg_match("/AMPDBUSER=(.*)/", $line, $matches)) $db_user = trim($matches[1]);
            if (preg_match("/AMPDBPASS=(.*)/", $line, $matches)) $db_pass = trim($matches[1]);
            if (preg_match("/AMPDBHOST=(.*)/", $line, $matches)) $db_host = trim($matches[1]);
        }
    }

    $pdo = new PDO("mysql:host=$db_host;dbname=asterisk", $db_user, $db_pass);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

    // 1. Find the extension by matching the Display Name
    $stmt = $pdo->prepare("SELECT extension FROM users WHERE name = :name LIMIT 1");
    $stmt->execute(['name' => $display_name]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        echo json_encode(["status" => "error", "message" => "Agent not found"]);
        exit;
    }
    $extension = $user['extension'];

    // 2. Get the current active status from synq_agent_status
    $stmt = $pdo->prepare("SELECT status, last_update FROM synq_agent_status WHERE extension = :ext LIMIT 1");
    $stmt->execute(['ext' => $extension]);
    $current = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($current && $current['status'] !== $status) {
        // Log the completion of the previous state
        $start_time = $current['last_update'];
        $stmt = $pdo->prepare("INSERT INTO synq_agent_status_log (extension, status, start_time, end_time, duration_seconds) 
                               VALUES (:ext, :old_status, :start_time, NOW(), TIMESTAMPDIFF(SECOND, :start_time, NOW()))");
        $stmt->execute([
            'ext' => $extension,
            'old_status' => $current['status'],
            'start_time' => $start_time
        ]);
    }

    // 3. Update or Insert the new current status
    $stmt = $pdo->prepare("INSERT INTO synq_agent_status (extension, display_name, status, last_update) 
                           VALUES (:ext, :name, :status, NOW()) 
                           ON DUPLICATE KEY UPDATE status = :status, last_update = NOW()");
    $stmt->execute([
        'ext' => $extension,
        'name' => $display_name,
        'status' => $status
    ]);

    echo json_encode(["status" => "success", "agent" => $extension, "new_state" => $status]);

} catch (PDOException $e) {
    echo json_encode(["status" => "error", "message" => "Database connection failed", "error" => $e->getMessage()]);
}
?>
