import json
import os
import re
from typing import Dict, List, Tuple, Optional, Any

def parse_filename(filename: str) -> Optional[Dict[str, str]]:
    """
    解析文件名，提取其结构化部分。
    期望的格式: ID-INDEX_CHANNELID-USERID_TIMESTAMP.EXTENSION
    """
    # 正则表达式来匹配文件名结构
    # 支持 ID-INDEX 或 ID_INDEX, 以及 CHANNELID-USERID 或 CHANNELID_USERID
    pattern = re.compile(
        r'^(?P<id>\d+)[-_](?P<index>\d+)_'
        r'(?P<channelId>\d+)[-_](?P<userId>\d+)_'
        r'(?P<timestamp>[^.]+)\.'
        r'(?P<extension>.+)$'
    )
    match = pattern.match(filename)
    if match:
        return match.groupdict()
    return None

def build_id_map_from_json(json_data: List[Dict[str, Any]]) -> Dict[int, Dict[str, str]]:
    """
    从JSON数据构建一个 ID -> {channelId, userId} 的映射字典。
    """
    id_map = {}
    for item in json_data:
        # 确保条目包含必要的信息
        if 'id' in item and 'channelId' in item and 'userId' in item:
            # 将所有ID转为字符串以保持一致性
            id_map[item['id']] = {
                'channelId': str(item['channelId']),
                'userId': str(item['userId'])
            }
    return id_map

def rename_files_based_on_id(json_filename="cave.json"):
    """
    根据JSON文件中的ID、channelId和userId，自动重命名文件夹中命名不一致的文件。
    """
    try:
        script_filename = os.path.basename(__file__)
    except NameError:
        script_filename = "rename_files_smart.py"

    # --- 步骤 1: 加载JSON数据并创建ID映射 ---
    try:
        with open(json_filename, 'r', encoding='utf-8') as f:
            data = json.load(f)
        id_map = build_id_map_from_json(data)
    except FileNotFoundError:
        print(f"❌ 错误: 在当前目录下未找到 '{json_filename}' 文件。")
        return
    except json.JSONDecodeError:
        print(f"❌ 错误: 无法解析 '{json_filename}' 的JSON格式。")
        return

    # --- 步骤 2: 获取当前目录下的所有文件 ---
    try:
        actual_files = {f for f in os.listdir('.') if os.path.isfile(f)}
    except OSError as e:
        print(f"❌ 读取目录时发生错误: {e}")
        return

    # --- 步骤 3: 分析文件并生成重命名计划 ---
    rename_plan: List[Tuple[str, str]] = []
    correctly_named_files: List[str] = []
    unrecognized_files: List[str] = []
    unmatched_files: List[str] = []
    
    files_to_process = actual_files - {json_filename, script_filename}

    for filename in files_to_process:
        parsed_parts = parse_filename(filename)
        
        # 如果文件名格式不符合预期，则跳过
        if not parsed_parts:
            unrecognized_files.append(filename)
            continue
        
        file_id = int(parsed_parts['id'])
        
        # 如果文件ID在JSON中找不到对应记录，则跳过
        if file_id not in id_map:
            unmatched_files.append(filename)
            continue
            
        correct_data = id_map[file_id]
        
        # 检查 channelId 和 userId 是否正确
        if (parsed_parts['channelId'] == correct_data['channelId'] and
            parsed_parts['userId'] == correct_data['userId']):
            correctly_named_files.append(filename)
        else:
            # 构建新的正确文件名
            new_name = (
                f"{parsed_parts['id']}-{parsed_parts['index']}_"
                f"{correct_data['channelId']}-{correct_data['userId']}_"
                f"{parsed_parts['timestamp']}.{parsed_parts['extension']}"
            )
            rename_plan.append((filename, new_name))

    # --- 步骤 4: 显示预览报告 ---
    print("\n--- 🔍 文件重命名计划预览 ---\n")
    
    has_issues = any([rename_plan, unrecognized_files, unmatched_files])
    if not has_issues:
        print(f"✅ 非常完美！在检查的 {len(correctly_named_files)} 个文件中，所有文件都已正确命名。")
        return

    if rename_plan:
        print(f"✍️ 将执行以下 {len(rename_plan)} 个重命名操作:")
        for old, new in rename_plan:
            print(f"  '{old}'  👉  '{new}'")
    
    if correctly_named_files:
        print(f"\n✅ {len(correctly_named_files)} 个文件已正确命名，无需改动。")
    
    if unmatched_files:
        print(f"\n❓ {len(unmatched_files)} 个文件无法匹配 (其ID在 '{json_filename}' 中未找到):")
        for f in sorted(unmatched_files):
            print(f"  - {f}")
            
    if unrecognized_files:
        print(f"\n⚠️ {len(unrecognized_files)} 个文件格式无法识别 (将被忽略):")
        for f in sorted(unrecognized_files):
            print(f"  - {f}")

    # --- 步骤 5: 请求用户确认并执行 ---
    if not rename_plan:
        print("\n--- 无需重命名，操作结束 ---")
        return
        
    print("-" * 30)
    try:
        confirm = input("\n🤔 是否执行以上重命名操作？ (请输入 y/yes 确认): ").lower()
    except KeyboardInterrupt:
        print("\n操作被用户取消。")
        return

    if confirm in ['y', 'yes']:
        print("\n--- 🚀 开始执行重命名 ---\n")
        success_count = 0
        fail_count = 0
        for old_name, new_name in rename_plan:
            try:
                # 再次检查，防止新文件名已存在
                if os.path.exists(new_name):
                    print(f"❌ 失败: 目标文件 '{new_name}' 已存在，跳过 '{old_name}'。")
                    fail_count += 1
                    continue
                os.rename(old_name, new_name)
                print(f"✅ 成功: '{old_name}' -> '{new_name}'")
                success_count += 1
            except OSError as e:
                print(f"❌ 失败: 无法重命名 '{old_name}' -> '{new_name}'. 错误: {e}")
                fail_count += 1
        print(f"\n--- ✨ 操作完成 ---")
        print(f"  成功: {success_count} 个文件")
        if fail_count > 0:
            print(f"  失败: {fail_count} 个文件")
    else:
        print("\n--- ❌ 操作已取消，未对任何文件进行修改 ---")

if __name__ == "__main__":
    rename_files_based_on_id()