"""Player data helpers: stats, bans, advancements."""

import json
import os
from pathlib import Path


# ── Advancement display names ────────────────────────────

ADVANCEMENT_NAMES = {
    # Story
    "minecraft:story/root": "Minecraft",
    "minecraft:story/mine_stone": "Stone Age",
    "minecraft:story/upgrade_tools": "Getting an Upgrade",
    "minecraft:story/smelt_iron": "Acquire Hardware",
    "minecraft:story/obtain_armor": "Suit Up",
    "minecraft:story/lava_bucket": "Hot Stuff",
    "minecraft:story/iron_tools": "Isn't It Iron Pick",
    "minecraft:story/deflect_arrow": "Not Today, Thank You",
    "minecraft:story/form_obsidian": "Ice Bucket Challenge",
    "minecraft:story/mine_diamond": "Diamonds!",
    "minecraft:story/enter_the_nether": "We Need to Go Deeper",
    "minecraft:story/shiny_gear": "Cover Me with Diamonds",
    "minecraft:story/enchant_item": "Enchanter",
    "minecraft:story/cure_zombie_villager": "Zombie Doctor",
    "minecraft:story/follow_ender_eye": "Eye Spy",
    "minecraft:story/enter_the_end": "The End?",
    # Adventure
    "minecraft:adventure/root": "Adventure",
    "minecraft:adventure/voluntary_exile": "Voluntary Exile",
    "minecraft:adventure/spyglass_at_parrot": "Is It a Bird?",
    "minecraft:adventure/spyglass_at_ghast": "Is It a Balloon?",
    "minecraft:adventure/spyglass_at_dragon": "Is It a Plane?",
    "minecraft:adventure/kill_a_mob": "Monster Hunter",
    "minecraft:adventure/kill_all_mobs": "Monsters Hunted",
    "minecraft:adventure/trade": "What a Deal!",
    "minecraft:adventure/trim_with_any_armor_pattern": "Crafting a New Look",
    "minecraft:adventure/honey_block_slide": "Sticky Situation",
    "minecraft:adventure/ol_betsy": "Ol' Betsy",
    "minecraft:adventure/sleep_in_bed": "Sweet Dreams",
    "minecraft:adventure/hero_of_the_village": "Hero of the Village",
    "minecraft:adventure/throw_trident": "A Throwaway Joke",
    "minecraft:adventure/shoot_arrow": "Take Aim",
    "minecraft:adventure/kill_mob_near_sculk_catalyst": "It Spreads",
    "minecraft:adventure/totem_of_undying": "Postmortem",
    "minecraft:adventure/summon_iron_golem": "Hired Help",
    "minecraft:adventure/trade_at_world_height": "Star Trader",
    "minecraft:adventure/two_birds_one_arrow": "Two Birds, One Arrow",
    "minecraft:adventure/whos_the_pillager_now": "Who's the Pillager Now?",
    "minecraft:adventure/arbalistic": "Arbalistic",
    "minecraft:adventure/adventuring_time": "Adventuring Time",
    "minecraft:adventure/play_jukebox_in_meadows": "Sound of Music",
    "minecraft:adventure/walk_on_powder_snow_with_leather_boots": "Light as a Rabbit",
    "minecraft:adventure/lightning_rod_with_villager_no_fire": "Surge Protector",
    "minecraft:adventure/fall_from_world_height": "Caves & Cliffs",
    "minecraft:adventure/salvage_sherd": "Respecting the Remnants",
    "minecraft:adventure/avoid_vibration": "Sneak 100",
    "minecraft:adventure/brush_armadillo": "Isn't It Scute?",
    "minecraft:adventure/minecraft_trials_edition": "Minecraft: Trial(s) Edition",
    "minecraft:adventure/under_lock_and_key": "Under Lock and Key",
    "minecraft:adventure/blowback": "Blowback",
    "minecraft:adventure/revaulting": "Re-vaulting",
    "minecraft:adventure/who_needs_rockets": "Who Needs Rockets?",
    # Husbandry
    "minecraft:husbandry/root": "Husbandry",
    "minecraft:husbandry/safely_harvest_honey": "Bee Our Guest",
    "minecraft:husbandry/breed_an_animal": "The Parrots and the Bats",
    "minecraft:husbandry/tame_an_animal": "Best Friends Forever",
    "minecraft:husbandry/plant_seed": "A Seedy Place",
    "minecraft:husbandry/bred_all_animals": "Two by Two",
    "minecraft:husbandry/fishy_business": "Fishy Business",
    "minecraft:husbandry/silk_touch_nest": "Total Beelocation",
    "minecraft:husbandry/tadpole_in_a_bucket": "Bukkit Bukkit",
    "minecraft:husbandry/make_a_sign_glow": "Glow and Behold!",
    "minecraft:husbandry/balanced_diet": "A Balanced Diet",
    "minecraft:husbandry/obtain_netherite_hoe": "Serious Dedication",
    "minecraft:husbandry/allay_deliver_item_to_player": "You've Got a Friend in Me",
    "minecraft:husbandry/ride_a_boat_with_a_goat": "Whatever Floats Your Goat",
    "minecraft:husbandry/wax_on": "Wax On",
    "minecraft:husbandry/wax_off": "Wax Off",
    "minecraft:husbandry/leash_all_frog_variants": "With Our Powers Combined!",
    "minecraft:husbandry/froglights": "With Our Powers Combined!",
    "minecraft:husbandry/tactical_fishing": "Tactical Fishing",
    "minecraft:husbandry/whole_pack": "The Whole Pack",
    "minecraft:husbandry/feed_snifflet": "Smells Interesting",
    "minecraft:husbandry/obtain_sniffer_egg": "Little Sniffs",
    "minecraft:husbandry/plant_any_sniffer_seed": "Planting the Past",
    "minecraft:husbandry/remove_wolf_armor": "Good as New",
    "minecraft:husbandry/shear_armadillo": "Shear Brilliance",
    # Nether
    "minecraft:nether/root": "Nether",
    "minecraft:nether/return_to_sender": "Return to Sender",
    "minecraft:nether/find_bastion": "Those Were the Days",
    "minecraft:nether/obtain_ancient_debris": "Hidden in the Depths",
    "minecraft:nether/fast_travel": "Subspace Bubble",
    "minecraft:nether/find_fortress": "A Terrible Fortress",
    "minecraft:nether/obtain_crying_obsidian": "Who Is Cutting Onions?",
    "minecraft:nether/distract_piglin": "Oh Shiny",
    "minecraft:nether/ride_strider": "This Boat Has Legs",
    "minecraft:nether/uneasy_alliance": "Uneasy Alliance",
    "minecraft:nether/loot_bastion": "War Pigs",
    "minecraft:nether/use_lodestone": "Country Lode, Take Me Home",
    "minecraft:nether/netherite_armor": "Cover Me in Debris",
    "minecraft:nether/get_wither_skull": "Spooky Scary Skeleton",
    "minecraft:nether/obtain_blaze_rod": "Into Fire",
    "minecraft:nether/charge_respawn_anchor": "Not Quite \"Nine\" Lives",
    "minecraft:nether/explore_nether": "Hot Tourist Destinations",
    "minecraft:nether/summon_wither": "Withering Heights",
    "minecraft:nether/brew_potion": "Local Brewery",
    "minecraft:nether/create_beacon": "Bring Home the Beacon",
    "minecraft:nether/all_potions": "A Furious Cocktail",
    "minecraft:nether/create_full_beacon": "Beaconator",
    "minecraft:nether/all_effects": "How Did We Get Here?",
    # End
    "minecraft:end/root": "The End",
    "minecraft:end/kill_dragon": "Free the End",
    "minecraft:end/dragon_egg": "The Next Generation",
    "minecraft:end/enter_end_gateway": "Remote Getaway",
    "minecraft:end/respawn_dragon": "The End... Again...",
    "minecraft:end/dragon_breath": "You Need a Mint",
    "minecraft:end/find_end_city": "The City at the End of the Game",
    "minecraft:end/elytra": "Sky's the Limit",
    "minecraft:end/levitate": "Great View From Up Here",
}


def load_bot_names():
    """Load bot usernames from chatbot personalities."""
    path = Path(__file__).parent.parent.parent / "chatbot" / "personalities.json"
    with open(path) as f:
        return {p["username"] for p in json.load(f)}


def load_usercache(server_dir):
    """Load UUID->name map from usercache.json."""
    with open(os.path.join(server_dir, "usercache.json")) as f:
        return {e["uuid"]: e["name"] for e in json.load(f)}


def name_to_uuid(uuid_to_name):
    """Invert uuid->name map to lowercased-name->uuid."""
    return {name.lower(): uuid for uuid, name in uuid_to_name.items()}


def load_bans(server_dir, bot_names):
    """Return (deathbanned_names, hackbanned_names) sets."""
    with open(os.path.join(server_dir, "banned-players.json")) as f:
        bans = json.load(f)
    deathbanned, hackbanned = set(), set()
    for ban in bans:
        name = ban["name"]
        if name in bot_names:
            continue
        reason = ban.get("reason", "")
        if "Deathban" in reason or "Game Over" in reason:
            deathbanned.add(name)
        else:
            hackbanned.add(name)
    return deathbanned, hackbanned


def load_ban_details(server_dir):
    """Load full ban records keyed by player name."""
    with open(os.path.join(server_dir, "banned-players.json")) as f:
        bans = json.load(f)
    return {ban["name"]: ban for ban in bans}


def get_player_stats(server_dir, uuid):
    """Load one player's stats JSON, or None if not found."""
    path = Path(server_dir) / "world" / "stats" / f"{uuid}.json"
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def get_player_advancements(server_dir, uuid):
    """Load completed non-recipe advancement IDs for a player."""
    path = Path(server_dir) / "world" / "advancements" / f"{uuid}.json"
    if not path.exists():
        return []
    try:
        with open(path) as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return []
    return sorted(
        k for k, v in data.items()
        if isinstance(v, dict) and v.get("done")
        and not k.startswith("minecraft:recipes/")
    )


def format_advancement(adv_id):
    """Convert advancement ID to display name."""
    if adv_id in ADVANCEMENT_NAMES:
        return ADVANCEMENT_NAMES[adv_id]
    # Fallback: strip namespace and path, title-case the slug
    name = adv_id.rsplit("/", 1)[-1]
    return name.replace("_", " ").title()


def summarize_player_stats(stats_data):
    """Produce a compact summary dict from raw stats JSON."""
    if not stats_data:
        return None

    s = stats_data.get("stats", {})
    custom = s.get("minecraft:custom", {})
    mined = s.get("minecraft:mined", {})
    crafted = s.get("minecraft:crafted", {})
    killed = s.get("minecraft:killed", {})
    killed_by = s.get("minecraft:killed_by", {})

    play_ticks = custom.get("minecraft:play_time", 0)
    total_seconds = play_ticks // 20
    hours, rem = divmod(total_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    if hours > 0:
        play_display = f"{hours}h {minutes}m {seconds}s"
    elif minutes > 0:
        play_display = f"{minutes} min {seconds} sec"
    else:
        play_display = f"{seconds} sec"

    diamonds = (
        mined.get("minecraft:diamond_ore", 0)
        + mined.get("minecraft:deepslate_diamond_ore", 0)
    )

    def _top(d, n=5):
        """Top-n items from a stat dict, formatted as 'name:count'."""
        items = sorted(d.items(), key=lambda x: x[1], reverse=True)[:n]
        return [
            f"{k.removeprefix('minecraft:')}:{v}" for k, v in items
        ]

    return {
        "play_ticks": play_ticks,
        "play_display": play_display,
        "mob_kills": custom.get("minecraft:mob_kills", 0),
        "player_kills": custom.get("minecraft:player_kills", 0),
        "deaths": custom.get("minecraft:deaths", 0),
        "diamonds": diamonds,
        "blocks_mined": sum(mined.values()),
        "items_crafted": sum(crafted.values()),
        "villager_trades": custom.get("minecraft:traded_with_villager", 0),
        "top_killed": _top(killed),
        "top_killed_by": _top(killed_by),
        "top_mined": _top(mined),
        "top_crafted": _top(crafted),
    }
